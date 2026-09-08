import type {
  VerificationStrategy,
  VerificationStrategyDescriptor,
  VerificationStrategyProvider,
} from "../schemas/verification-types.js";

export class VerificationStrategyFactory {
  readonly #providers = new Map<string, VerificationStrategyProvider>();

  constructor(providers: readonly VerificationStrategyProvider[]) {
    for (const provider of providers) {
      const descriptor = requireDescriptor(provider.descriptor);
      if (this.#providers.has(descriptor.id)) {
        throw new Error(`Duplicate verification strategy: ${descriptor.id}`);
      }
      this.#providers.set(descriptor.id, {
        descriptor,
        create: provider.create,
      });
    }
  }

  resolve(strategyId: string): VerificationStrategyProvider {
    const id = requireStrategyId(strategyId);
    const provider = this.#providers.get(id);
    if (provider === undefined) {
      throw new Error(`Unknown verification strategy: ${id}`);
    }
    return { descriptor: { ...provider.descriptor }, create: provider.create };
  }

  create(strategyId: string): VerificationStrategy {
    return this.resolve(strategyId).create();
  }

  list(): VerificationStrategyDescriptor[] {
    return [...this.#providers.values()].map((provider) => ({
      ...provider.descriptor,
    }));
  }
}

function requireDescriptor(
  descriptor: VerificationStrategyDescriptor,
): VerificationStrategyDescriptor {
  if (!isRecord(descriptor)) {
    throw new Error("Verification strategy provider descriptor is invalid.");
  }

  const id = trimRequired(descriptor.id);
  const version = trimRequired(descriptor.version);
  const displayName = trimRequired(descriptor.displayName);
  if (!id || !version || !displayName) {
    throw new Error("Verification strategy provider descriptor is invalid.");
  }

  return { id, version, displayName };
}

function requireStrategyId(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Unknown verification strategy: ");
  }
  const id = value.trim();
  if (id.length === 0) {
    throw new Error("Unknown verification strategy: ");
  }
  return id;
}

function trimRequired(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
