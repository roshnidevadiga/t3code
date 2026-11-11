import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";

/**
 * Who an install belongs to. `connect` is the T3 Connect account and `device`
 * is a client device that connected. Provider login files (`~/.codex`,
 * `~/.claude.json`) are deliberately never read for analytics.
 */
export const TelemetryOwnerSource = Schema.Literals(["connect", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  /** `hashTelemetryId` of the source's raw id. */
  readonly ownerId: string;
}

export const TelemetryIdentitySource = Schema.Literal("anonymous");
export type TelemetryIdentitySource = typeof TelemetryIdentitySource.Type;

class TelemetryIdentityReadError extends Schema.TaggedError<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    source: TelemetryIdentitySource,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.source} telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError;

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (cause instanceof PlatformError.PlatformError) {
    return {
      causeKind: "platform",
      platformReason: cause.reason._tag,
    };
  }
  return { causeKind: "other" };
};

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      source: error.source,
      filePath: error.filePath,
      ...getTelemetryIdentityCauseAnnotations(error.cause),
      ...(error.stack === undefined ? {} : { errorStack: error.stack }),
    }),
  );

const readIdentityFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new TelemetryIdentityReadError({
                source: "anonymous",
                filePath,
                cause,
              }),
            ),
    }),
  );

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* SecureRandom.SecureRandom.pipe(
    Effect.flatMap((crypto) => crypto.uuidV4()),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({ filePath: anonymousIdPath, contents: anonymousId }).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdPersistenceError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );

  return anonymousId;
});

/**
 * `distinctId` and `installId` are both the hashed random install id, so no
 * account identifier is ever used. A null `distinctId` disables telemetry.
 */
export const getTelemetryIdentity = Effect.gen(function* () {
  const installId = yield* upsertAnonymousId.pipe(
    Effect.map(hashTelemetryId),
    Effect.catch((error) => logTelemetryIdentityError(error).pipe(Effect.as(null))),
  );
  return { distinctId: installId, installId };
});

/** The linked T3 Connect account, the only owner the server reads itself. */
export const getServerOwners = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const connectUser = yield* secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read the linked T3 Connect account for telemetry", {
        errorTag: cause._tag,
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );
  return Option.isSome(connectUser) && connectUser.value.trim() !== ""
    ? [{ source: "connect", ownerId: hashTelemetryId(connectUser.value) } as const]
    : [];
});
