import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { useApiError, useApp } from "../../lib/app-context";
import { transcribeAudio } from "./useChatApi";

export interface VoiceInputButtonProps {
  disabled?: boolean;
  onText: (text: string) => void;
  onError?: (message: string) => void;
}

/** Browser-native microphone capture; audio bytes only cross the Agent API. */
export function VoiceInputButton({ disabled = false, onText, onError }: VoiceInputButtonProps) {
  const { client } = useApp();
  const toMessage = useApiError();
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => () => {
    if (recorder.current?.state === "recording") {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function reportError(message: string) {
    onError?.(message);
  }

  async function start() {
    onError?.("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      reportError("当前浏览器不支持录音");
      return;
    }
    let mediaStream: MediaStream | undefined;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
      stream.current = mediaStream;
      recorder.current = mediaRecorder;
      chunks.current = [];
      mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.current.push(event.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks.current, { type: mediaRecorder.mimeType || mimeType || "audio/webm" });
        const file = new File([blob], `recording-${Date.now()}.${audioExtension(blob.type)}`, { type: blob.type });
        void finish(file);
      };
      mediaRecorder.start();
      setRecording(true);
    } catch {
      mediaStream?.getTracks().forEach((track) => track.stop());
      reportError("无法访问麦克风，请检查浏览器权限");
    }
  }

  function stop() {
    recorder.current?.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  }

  async function finish(file: File) {
    setBusy(true);
    try {
      const result = await transcribeAudio(client, file);
      if (result.text.trim()) onText(result.text.trim());
    } catch (cause) {
      reportError(toMessage(cause));
    } finally {
      setBusy(false);
      recorder.current = null;
      stream.current = null;
      chunks.current = [];
    }
  }

  return (
      <Button
        label={busy ? "正在转写" : recording ? "停止录音" : "语音输入"}
        tooltip={busy ? "正在转写录音" : recording ? "停止录音并转写" : "语音输入"}
        variant={recording ? "secondary" : "ghost"}
        size="sm"
        icon={<span aria-hidden="true">{recording ? "■" : "🎙"}</span>}
        isIconOnly
        isDisabled={disabled || busy}
        aria-pressed={recording}
        onClick={() => (recording ? stop() : void start())}
      />
  );
}

function pickMimeType(): string | undefined {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return undefined;
}

function audioExtension(mimeType: string): string {
  const base = mimeType.split(";", 1)[0]?.toLowerCase();
  return base === "audio/ogg" ? "ogg" : base === "audio/mp4" ? "m4a" : base === "audio/wav" ? "wav" : "webm";
}
