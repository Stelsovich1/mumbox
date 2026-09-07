import type { Page } from "@playwright/test";

/**
 * A Web Audio mock that actually exercises `startBufferRoute`.
 *
 * The mock in `tests/e2e/app-shell.spec.ts` defines no `createBufferSource`, so every one of the
 * existing tests falls through to `startMediaElementFallback`. That mock is deliberately left
 * untouched — this is an opt-in second mock used only by the new specs.
 *
 * Two design points matter:
 *   - The audio clock is controllable (`advanceAudioClock`). `onended` never fires on a real
 *     timer, because a loop restart on a wall-clock timer either makes tests 10 s slow or
 *     recurses synchronously inside `startBufferRoute`'s `onended`.
 *   - `OfflineAudioContext` is mocked too. Without it `decodeAudioBlob` rejects and `playCell`
 *     returns before ever reaching the buffer route.
 */

export type AudioMockOptions = {
  /** Fallback duration in seconds when the payload is not a parseable WAV. */
  decodedDuration?: number;
  decodedSampleRate?: number;
  decodedChannels?: 1 | 2;
  /** Delays `decodeAudioData` resolution, to make play-token races deterministic. */
  decodeDelayMs?: number;
  contextState?: "running" | "suspended" | "interrupted";
  /** When false, `createBufferSource` is absent and the media-element fallback is driven. */
  bufferSource?: boolean;
  /**
   * Makes the Nth `Blob.slice(...).arrayBuffer()` reject (1-based); 0 disables it.
   *
   * The byte-range path reads through `blob.slice`, and for WAV it never calls `decodeAudioData` at
   * all — the conversion is our own arithmetic — so a decode-level failure injection cannot reach
   * it. Failing a read is the only way to exercise what happens when a segment cannot be fetched,
   * which is what both the give-up path and the watchdog exist for. Without this, a mutation to
   * either of them survives every test.
   */
  failNthRangeRead?: number;
};

export type MockCurveCall = { curve: number[]; startTime: number; duration: number };
export type MockRampCall = { value: number; endTime: number };

export type MockParamProbe = {
  id: number;
  value: number;
  setValueCalls: { value: number; startTime: number }[];
  curveCalls: number;
  curves: MockCurveCall[];
  ramps: MockRampCall[];
  cancelCalls: number;
};

export type MockGainProbe = {
  id: number;
  contextId: number;
  gain: MockParamProbe;
  connectCalls: number;
  disconnectCalls: number;
};

export type MockSourceProbe = {
  id: number;
  contextId: number;
  bufferDuration: number;
  startCalls: { when: number; offset: number; duration: number | null }[];
  stopCalls: number[];
  disconnectCalls: number;
  ended: boolean;
};

export type MockContextProbe = {
  id: number;
  kind: "audio" | "offline";
  state: string;
  closed: boolean;
  broken: boolean;
  sampleRate: number;
};

export type MockDecodeProbe = {
  inputBytes: number;
  startedAt: number;
  settledAt: number | null;
  ok: boolean | null;
  outputLength: number;
  outputChannels: number;
};

export type MockMediaElementProbe = {
  id: number;
  src: string;
  currentTime: number;
  playCalls: number;
  pauseCalls: number;
  volume: number;
  ended: boolean;
};

export type AudioProbe = {
  clock: number;
  contexts: MockContextProbe[];
  gains: MockGainProbe[];
  sources: MockSourceProbe[];
  decodes: MockDecodeProbe[];
  mediaElements: MockMediaElementProbe[];
  objectUrls: { created: string[]; revoked: string[] };
};

const MOCK_SCRIPT = (options: Required<AudioMockOptions>) => {
  type Probe = {
    clock: number;
    nextId: number;
    contexts: unknown[];
    gains: unknown[];
    sources: unknown[];
    decodes: unknown[];
    mediaElements: unknown[];
    objectUrls: { created: string[]; revoked: string[] };
    liveSources: unknown[];
    liveMedia: unknown[];
    advance: (seconds: number) => void;
    setContextState: (state: string) => void;
    snapshot: () => unknown;
  };

  const probe: Probe = {
    clock: 0,
    nextId: 0,
    contexts: [],
    gains: [],
    sources: [],
    decodes: [],
    mediaElements: [],
    objectUrls: { created: [], revoked: [] },
    liveSources: [],
    liveMedia: [],
    advance: () => undefined,
    setContextState: () => undefined,
    snapshot: () => undefined
  };

  const nextId = () => {
    probe.nextId += 1;
    return probe.nextId;
  };

  class MockAudioParam {
    record: {
      id: number;
      value: number;
      setValueCalls: { value: number; startTime: number }[];
      curveCalls: number;
      curves: { curve: number[]; startTime: number; duration: number }[];
      ramps: { value: number; endTime: number }[];
      cancelCalls: number;
    };

    throwOnCurve = false;

    constructor() {
      this.record = {
        id: nextId(),
        value: 1,
        setValueCalls: [],
        curveCalls: 0,
        curves: [],
        ramps: [],
        cancelCalls: 0
      };
    }

    get value() {
      return this.record.value;
    }

    set value(next: number) {
      this.record.value = next;
    }

    setValueAtTime(value: number, startTime: number) {
      this.record.value = value;
      this.record.setValueCalls.push({ value, startTime });
      return this;
    }

    cancelScheduledValues(startTime: number) {
      void startTime;
      this.record.cancelCalls += 1;
      return this;
    }

    // Recorded but deliberately not applied to `value`, so volume assertions stay meaningful
    // while `stopRoute`'s release ramp is still observable.
    linearRampToValueAtTime(value: number, endTime: number) {
      this.record.ramps.push({ value, endTime });
      return this;
    }

    setValueCurveAtTime(curve: Float32Array, startTime: number, duration: number) {
      if ((window as unknown as { __mumboxThrowOnCurve?: boolean }).__mumboxThrowOnCurve) {
        const error = new Error("setValueCurveAtTime overlap");
        error.name = "InvalidStateError";
        throw error;
      }
      this.record.curveCalls += 1;
      this.record.curves.push({
        curve: Array.from(curve),
        startTime,
        duration
      });
      this.record.value = curve.length > 0 ? (curve[0] ?? 1) : 1;
      return this;
    }
  }

  class MockGainNode {
    gain = new MockAudioParam();
    // `scheduleEnvelope` reads `gain.context.currentTime`, so a gain node without a context
    // reference throws before a single curve is ever scheduled.
    context: { currentTime: number };
    record: {
      id: number;
      contextId: number;
      gain: unknown;
      connectCalls: number;
      disconnectCalls: number;
    };

    constructor(contextId: number, context: { currentTime: number }) {
      this.context = context;
      this.record = {
        id: nextId(),
        contextId,
        gain: this.gain.record,
        connectCalls: 0,
        disconnectCalls: 0
      };
      probe.gains.push(this.record);
    }

    connect(target: unknown) {
      this.record.connectCalls += 1;
      return target;
    }

    disconnect() {
      this.record.disconnectCalls += 1;
    }
  }

  class MockAudioBuffer {
    length: number;
    numberOfChannels: number;
    sampleRate: number;
    private channels: (Float32Array | undefined)[];

    constructor(numberOfChannels: number, length: number, sampleRate: number) {
      this.numberOfChannels = numberOfChannels;
      this.length = length;
      this.sampleRate = sampleRate;
      this.channels = new Array<Float32Array | undefined>(numberOfChannels);
    }

    get duration() {
      return this.length / this.sampleRate;
    }

    getChannelData(channel: number) {
      let data = this.channels[channel];
      if (!data) {
        data = new Float32Array(this.length);
        for (let index = 0; index < this.length; index += 1) {
          data[index] = Math.sin((index / this.sampleRate) * 2 * Math.PI * 220);
        }
        this.channels[channel] = data;
      }
      return data;
    }

    copyToChannel(source: Float32Array, channel: number) {
      const target = this.getChannelData(channel);
      target.set(source.subarray(0, target.length));
    }
  }

  class MockAudioBufferSourceNode {
    buffer: MockAudioBuffer | null = null;
    onended: (() => void) | null = null;
    record: {
      id: number;
      contextId: number;
      bufferDuration: number;
      startCalls: { when: number; offset: number; duration: number | null }[];
      stopCalls: number[];
      disconnectCalls: number;
      ended: boolean;
    };
    endsAtClock: number | null = null;

    constructor(contextId: number) {
      this.record = {
        id: nextId(),
        contextId,
        bufferDuration: 0,
        startCalls: [],
        stopCalls: [],
        disconnectCalls: 0,
        ended: false
      };
      probe.sources.push(this.record);
      probe.liveSources.push(this);
    }

    connect(target: unknown) {
      return target;
    }

    disconnect() {
      this.record.disconnectCalls += 1;
    }

    start(when?: number, offset?: number, duration?: number) {
      const resolvedOffset = offset ?? 0;
      const resolvedDuration = duration ?? null;
      this.record.bufferDuration = this.buffer ? this.buffer.duration : 0;
      this.record.startCalls.push({
        when: when ?? 0,
        offset: resolvedOffset,
        duration: resolvedDuration
      });
      const playFor =
        resolvedDuration ?? (this.buffer ? this.buffer.duration - resolvedOffset : 0);
      // `when` must be honoured, not ignored: a source scheduled into the future ends that much
      // later, and treating every start as "now" would make any future-scheduled source — the
      // whole basis of a segment handoff — end at the wrong clock and fire `onended` early.
      // Invisible to specs that pass no `when`, since `max(clock, 0)` is `clock`.
      const startsAt = Math.max(probe.clock, when ?? 0);
      this.endsAtClock = startsAt + Math.max(0, playFor);
    }

    stop(when?: number) {
      const at = when ?? probe.clock;
      this.record.stopCalls.push(at);
      this.endsAtClock = Math.max(probe.clock, at);
    }
  }

  const parseWavHeader = (bytes: Uint8Array) => {
    if (bytes.byteLength < 44) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
    if (tag !== "RIFF") {
      return null;
    }
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const dataBytes = view.getUint32(40, true);
    if (channels === 0 || sampleRate === 0) {
      return null;
    }
    return {
      channels,
      sampleRate,
      frames: Math.floor(dataBytes / (channels * 2))
    };
  };

  const decodeAudioDataImpl = (data: ArrayBuffer) => {
    const record = {
      inputBytes: data.byteLength,
      startedAt: performance.now(),
      settledAt: null as number | null,
      ok: null as boolean | null,
      outputLength: 0,
      outputChannels: 0
    };
    probe.decodes.push(record);

    return new Promise<MockAudioBuffer>((resolve, reject) => {
      const settle = () => {
        if (data.byteLength === 0) {
          record.settledAt = performance.now();
          record.ok = false;
          reject(new Error("EncodingError: empty payload"));
          return;
        }
        const header = parseWavHeader(new Uint8Array(data));
        const channels = header ? header.channels : options.decodedChannels;
        const sampleRate = options.decodedSampleRate;
        const frames = header
          ? Math.round((header.frames * sampleRate) / header.sampleRate)
          : Math.round(options.decodedDuration * sampleRate);
        const buffer = new MockAudioBuffer(channels, frames, sampleRate);
        record.settledAt = performance.now();
        record.ok = true;
        record.outputLength = frames;
        record.outputChannels = channels;
        resolve(buffer);
      };

      if (options.decodeDelayMs > 0) {
        window.setTimeout(settle, options.decodeDelayMs);
      } else {
        queueMicrotask(settle);
      }
    });
  };

  class MockBaseContext {
    record: {
      id: number;
      kind: string;
      state: string;
      closed: boolean;
      broken: boolean;
      sampleRate: number;
    };
    destination = { channelCount: 2 };

    constructor(kind: string, sampleRate: number) {
      this.record = {
        id: nextId(),
        kind,
        state: options.contextState,
        closed: false,
        broken: false,
        sampleRate
      };
      probe.contexts.push(this.record);
    }

    get sampleRate() {
      return this.record.sampleRate;
    }

    get state() {
      return this.record.state;
    }

    get currentTime() {
      return probe.clock;
    }

    createGain() {
      return new MockGainNode(this.record.id, this);
    }

    createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
      return new MockAudioBuffer(numberOfChannels, length, sampleRate);
    }

    decodeAudioData(data: ArrayBuffer) {
      return decodeAudioDataImpl(data);
    }

    resume() {
      // A context marked broken refuses to come back, the way an interrupted iOS context does.
      // `getPlayableContext` must then close it and build a fresh one.
      if (!this.record.broken) {
        this.record.state = "running";
      }
      return Promise.resolve();
    }

    close() {
      this.record.state = "closed";
      this.record.closed = true;
      return Promise.resolve();
    }
  }

  class MockAudioContext extends MockBaseContext {
    constructor() {
      super("audio", options.decodedSampleRate);
    }

    createMediaElementSource(element: unknown) {
      void element;
      return {
        connect: (target: unknown) => target,
        disconnect: () => undefined
      };
    }
  }

  class MockOfflineAudioContext extends MockBaseContext {
    constructor(_channels?: number, _length?: number, sampleRate?: number) {
      super("offline", sampleRate ?? options.decodedSampleRate);
    }
  }

  if (options.bufferSource) {
    (MockAudioContext.prototype as unknown as Record<string, unknown>).createBufferSource =
      function createBufferSource(this: MockAudioContext) {
        return new MockAudioBufferSourceNode(this.record.id);
      };
  }

  class MockAudio extends EventTarget {
    record: {
      id: number;
      src: string;
      currentTime: number;
      playCalls: number;
      pauseCalls: number;
      volume: number;
      ended: boolean;
    };
    preload = "";
    private time = 0;
    private vol = 1;

    constructor(src = "") {
      super();
      this.record = {
        id: nextId(),
        src,
        currentTime: 0,
        playCalls: 0,
        pauseCalls: 0,
        volume: 1,
        ended: false
      };
      probe.mediaElements.push(this.record);
      probe.liveMedia.push(this);
      queueMicrotask(() => {
        this.dispatchEvent(new Event("loadedmetadata"));
      });
    }

    get duration() {
      return options.decodedDuration;
    }

    get currentTime() {
      return this.time;
    }

    set currentTime(next: number) {
      this.time = next;
      this.record.currentTime = next;
    }

    get volume() {
      return this.vol;
    }

    set volume(next: number) {
      this.vol = next;
      this.record.volume = next;
    }

    play() {
      this.record.playCalls += 1;
      this.record.ended = false;
      return Promise.resolve();
    }

    pause() {
      this.record.pauseCalls += 1;
    }

    load() {
      // no-op
    }

    removeAttribute() {
      // no-op
    }

    canPlayType() {
      return "maybe";
    }
  }

  probe.advance = (seconds: number) => {
    probe.clock += seconds;
    const sources = probe.liveSources.slice() as MockAudioBufferSourceNode[];
    for (const source of sources) {
      if (
        !source.record.ended &&
        source.endsAtClock !== null &&
        source.endsAtClock <= probe.clock + 1e-9
      ) {
        source.record.ended = true;
        source.onended?.();
      }
    }
    const elements = probe.liveMedia.slice() as MockAudio[];
    for (const element of elements) {
      if (element.record.playCalls > 0 && !element.record.ended) {
        element.currentTime = element.currentTime + seconds;
      }
    }
  };

  probe.setContextState = (state: string) => {
    for (const record of probe.contexts as {
      state: string;
      closed: boolean;
      broken: boolean;
    }[]) {
      if (!record.closed) {
        record.state = state;
        record.broken = state !== "running";
      }
    }
  };

  probe.snapshot = () => ({
    clock: probe.clock,
    contexts: probe.contexts,
    gains: probe.gains,
    sources: probe.sources,
    decodes: probe.decodes,
    mediaElements: probe.mediaElements,
    objectUrls: probe.objectUrls
  });

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (item: Blob | MediaSource) => {
    const url = originalCreateObjectURL(item);
    probe.objectUrls.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    probe.objectUrls.revoked.push(url);
    originalRevokeObjectURL(url);
  };

  if (options.failNthRangeRead > 0) {
    // Wraps `arrayBuffer` on slices only, by counting every call and rejecting the chosen one. The
    // byte-range reader is the only thing in the app that reads blobs this way, so this is a
    // targeted failure injection rather than a blanket outage.
    // Typed through a `this`-annotated shape rather than read straight off the prototype: an
    // unannotated `Blob.prototype.arrayBuffer` is an unbound method reference, which the lint rules
    // reject for good reason.
    const proto = Blob.prototype as unknown as {
      arrayBuffer: (this: Blob) => Promise<ArrayBuffer>;
    };
    const original = proto.arrayBuffer;
    let reads = 0;
    proto.arrayBuffer = function patchedArrayBuffer(this: Blob) {
      reads += 1;
      if (reads === options.failNthRangeRead) {
        return Promise.reject(new Error("injected range-read failure"));
      }
      return original.call(this);
    };
  }

  Object.defineProperty(window, "__mumboxAudio", { value: probe, configurable: true });
  Object.defineProperty(window, "AudioContext", { value: MockAudioContext, configurable: true });
  Object.defineProperty(window, "webkitAudioContext", {
    value: MockAudioContext,
    configurable: true
  });
  Object.defineProperty(window, "OfflineAudioContext", {
    value: MockOfflineAudioContext,
    configurable: true
  });
  Object.defineProperty(window, "Audio", { value: MockAudio, configurable: true });
};

function resolveOptions(options: AudioMockOptions, bufferSource: boolean): Required<AudioMockOptions> {
  return {
    decodedDuration: options.decodedDuration ?? 10,
    decodedSampleRate: options.decodedSampleRate ?? 44_100,
    decodedChannels: options.decodedChannels ?? 1,
    decodeDelayMs: options.decodeDelayMs ?? 0,
    contextState: options.contextState ?? "running",
    bufferSource,
    failNthRangeRead: options.failNthRangeRead ?? 0
  };
}

/** Drives `startBufferRoute` — the path every real browser takes. */
export async function installBufferAudioMock(page: Page, options: AudioMockOptions = {}) {
  await page.addInitScript(MOCK_SCRIPT, resolveOptions(options, true));
}

/** Drives `startMediaElementFallback`, but with a working `disconnect`/`close`/`revoke` tail. */
export async function installMediaAudioMock(page: Page, options: AudioMockOptions = {}) {
  await page.addInitScript(MOCK_SCRIPT, resolveOptions(options, false));
}

export async function readProbe(page: Page): Promise<AudioProbe> {
  return page.evaluate(
    () =>
      (window as unknown as { __mumboxAudio: { snapshot: () => AudioProbe } }).__mumboxAudio.snapshot()
  );
}

export async function advanceAudioClock(page: Page, seconds: number) {
  await page.evaluate((value) => {
    (window as unknown as { __mumboxAudio: { advance: (s: number) => void } }).__mumboxAudio.advance(
      value
    );
  }, seconds);
}

/** Forces every open context into a non-running state, to exercise `getPlayableContext` recovery. */
export async function breakAudioContext(page: Page, state = "interrupted") {
  await page.evaluate((value) => {
    (
      window as unknown as { __mumboxAudio: { setContextState: (s: string) => void } }
    ).__mumboxAudio.setContextState(value);
  }, state);
}

export async function setCurveThrowing(page: Page, throwing: boolean) {
  await page.evaluate((value) => {
    (window as unknown as { __mumboxThrowOnCurve?: boolean }).__mumboxThrowOnCurve = value;
  }, throwing);
}
