import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = Effect.fn("test.sha256")(function* (value: string) {
  const digest = yield* Digest.Digest;
  return Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(Effect.orDie),
  );
});

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (
  logs: ReadonlyArray<CapturedLog>,
  source: Identify.TelemetryIdentitySource,
  errorTag: string,
) => logs.find((log) => log.annotations.source === source && log.annotations.errorTag === errorTag);

const layerIdentity = (prefix: string, logs?: CapturedLog[]) =>
  Layer.provideMerge(
    ServerSecretStore.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }),
  ).pipe(
    Layer.merge(
      logs === undefined
        ? Layer.empty
        : Logger.layer([makeCaptureLogger(logs)], { mergeWithExisting: false }),
    ),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("telemetry identity", (it) => {
  it.effect("identifies the install by its random id and reads no provider login file", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const anonymousId = "persisted-anonymous-id";
      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);
      const installId = yield* sha256(anonymousId);
      const readPaths: string[] = [];
      const spyFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (filePath, encoding) => {
          readPaths.push(filePath);
          return fileSystem.readFileString(filePath, encoding);
        },
        readFile: (filePath) => {
          readPaths.push(filePath);
          return fileSystem.readFile(filePath);
        },
      });

      const identity = yield* Identify.getTelemetryIdentity.pipe(
        Effect.provideService(FileSystem.FileSystem, spyFileSystem),
      );

      assert.deepEqual(identity, { distinctId: installId, installId });
      assert.deepEqual(readPaths, [config.anonymousIdPath]);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-install-"))),
  );

  it.effect("leaves no torn anonymous id behind when its write fails midway", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const tornWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (filePath, data, options) =>
          fileSystem
            .writeFileString(filePath, data.slice(0, Math.floor(data.length / 2)), options)
            .pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "WriteZero",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: filePath,
                  }),
                ),
              ),
            ),
      });

      const identity = yield* Identify.getTelemetryIdentity.pipe(
        Effect.provideService(FileSystem.FileSystem, tornWrites),
      );

      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-torn-"))),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identity = yield* Identify.getTelemetryIdentity;
      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "anonymous", "TelemetryIdentityReadError");
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      assert.isUndefined(
        findIdentityLog(logs, "anonymous", "TelemetryAnonymousIdPersistenceError"),
      );
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-read-", logs)));
  });

  it.effect("reports only the linked Connect account as a server owner", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      assert.deepEqual(yield* Identify.getServerOwners, []);

      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("user_connect"));

      assert.deepEqual(yield* Identify.getServerOwners, [
        { source: "connect", ownerId: yield* sha256("user_connect") },
      ]);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-owners-"))),
  );
});
