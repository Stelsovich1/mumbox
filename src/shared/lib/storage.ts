export type StorageEstimateResult = {
  usage: number | null;
  quota: number | null;
  available: number | null;
  persistent: boolean | null;
};

type RuntimeStorageManager = {
  estimate?: () => Promise<StorageEstimate>;
  persist?: () => Promise<boolean>;
};

function getRuntimeStorage() {
  return navigator.storage as RuntimeStorageManager | undefined;
}

export async function requestPersistentStorage() {
  const storage = getRuntimeStorage();
  if (!storage?.persist) {
    return null;
  }

  try {
    return await storage.persist();
  } catch {
    return null;
  }
}

export async function estimateStorage(): Promise<StorageEstimateResult> {
  const storage = getRuntimeStorage();
  const persistent = await requestPersistentStorage();
  if (!storage?.estimate) {
    return {
      usage: null,
      quota: null,
      available: null,
      persistent
    };
  }

  try {
    const estimate = await storage.estimate();
    const usage = estimate.usage ?? null;
    const quota = estimate.quota ?? null;
    return {
      usage,
      quota,
      available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
      persistent
    };
  } catch {
    return {
      usage: null,
      quota: null,
      available: null,
      persistent
    };
  }
}

export async function hasLikelyStorageForBytes(bytes: number) {
  const estimate = await estimateStorage();
  if (estimate.available === null) {
    return {
      enough: true,
      estimate
    };
  }

  return {
    enough: estimate.available > bytes * 1.15,
    estimate
  };
}
