import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceInputButton } from "./VoiceInputButton";

const transcribeAudio = vi.hoisted(() => vi.fn());

vi.mock("../../lib/app-context", () => ({
  useApp: () => ({ client: {} }),
  useApiError: () => (cause: unknown) => cause instanceof Error ? cause.message : "转写失败",
}));
vi.mock("./useChatApi", () => ({ transcribeAudio }));

let supportedMime: string | null = "audio/ogg;codecs=opus";
let recordedMime = "audio/ogg";

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((mimeType: string) => mimeType === supportedMime);
  state: RecordingState = "inactive";
  mimeType = recordedMime;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

function installRecorder(): void {
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
}

function installMediaDevices(getUserMedia: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

function renderButton(onText = vi.fn(), onError = vi.fn()) {
  return {
    onText,
    onError,
    ...render(<VoiceInputButton onText={onText} onError={onError} />),
  };
}

afterEach(() => {
  supportedMime = "audio/ogg;codecs=opus";
  recordedMime = "audio/ogg";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("VoiceInputButton", () => {
  it("在浏览器不支持录音时报告错误", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { onError } = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));

    expect(onError).toHaveBeenCalledWith("当前浏览器不支持录音");
  });

  it("无法获取麦克风权限时停止媒体流并报告错误", async () => {
    installRecorder();
    installMediaDevices(async () => { throw new Error("permission denied"); });
    const { onError } = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("无法访问麦克风，请检查浏览器权限"));
  });

  it("录音完成后提交音频并回填转写文本", async () => {
    installRecorder();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    installMediaDevices(async () => stream);
    transcribeAudio.mockResolvedValue({ text: "  你好，AI Team  " });
    const { onText } = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));

    await waitFor(() => expect(transcribeAudio).toHaveBeenCalledWith({}, expect.objectContaining({ type: "audio/ogg" })));
    expect(onText).toHaveBeenCalledWith("你好，AI Team");
    expect(stopTrack).toHaveBeenCalled();
  });

  it("空转写不回填，且转写失败显示错误", async () => {
    installRecorder();
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    installMediaDevices(async () => stream);
    transcribeAudio.mockResolvedValueOnce({ text: "  " });
    const { onText, onError } = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));
    await waitFor(() => expect(transcribeAudio).toHaveBeenCalled());
    expect(onText).not.toHaveBeenCalled();

    transcribeAudio.mockRejectedValueOnce(new Error("upstream failed"));
    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("upstream failed"));
  });

  it("卸载录音组件时释放媒体轨道", async () => {
    installRecorder();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    installMediaDevices(async () => stream);
    const view = renderButton();

    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeInTheDocument());
    view.unmount();

    expect(stopTrack).toHaveBeenCalled();
  });
});
