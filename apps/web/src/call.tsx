import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Socket } from "socket.io-client";
import {
  Disc,
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Sparkles,
  SwitchCamera,
  Video,
  VideoOff
} from "lucide-react";
import { api } from "./api";
import { createBlurredTrack, type BlurHandle } from "./blur";
import type { CallType, IncomingCall, User } from "./types";

type CallState = "idle" | "outgoing" | "incoming" | "active";

type ActiveCall = {
  state: CallState;
  callId: string;
  type: CallType;
  peer: User;
};

type SignalPayload = { callId: string; from: string; data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };

type CallController = {
  startCall: (conversationId: string, type: CallType, peer: User) => void;
  inCall: boolean;
};

const CallContext = createContext<CallController>({ startCall: () => {}, inCall: false });

export function useCall() {
  return useContext(CallContext);
}

const FALLBACK_ICE: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];

export function CallProvider({
  socket,
  self,
  token,
  children
}: {
  socket: Socket | null;
  self: User;
  token: string;
  children: ReactNode;
}) {
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [blurOn, setBlurOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localPreviewRef = useRef<MediaStream>(new MediaStream());
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  const rawCameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const blurHandleRef = useRef<BlurHandle | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);

  const callIdRef = useRef("");
  const peerIdRef = useRef("");
  const callTypeRef = useRef<CallType>("AUDIO");
  const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const signalQueueRef = useRef<SignalPayload[]>([]);
  const drainingRef = useRef(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);

  const cleanup = useCallback(() => {
    pcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;
    rawCameraTrackRef.current?.stop();
    rawCameraTrackRef.current = null;
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    blurHandleRef.current?.stop();
    blurHandleRef.current = null;
    videoSenderRef.current = null;
    localPreviewRef.current.getTracks().forEach((track) => {
      track.stop();
      localPreviewRef.current.removeTrack(track);
    });
    remoteStreamRef.current.getTracks().forEach((track) => remoteStreamRef.current.removeTrack(track));
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recorderRef.current = null;
    recordedChunksRef.current = [];
    pendingCandidatesRef.current = [];
    signalQueueRef.current = [];
    callIdRef.current = "";
    peerIdRef.current = "";
    setMuted(false);
    setCameraOff(false);
    setSharing(false);
    setBlurOn(false);
    setRecording(false);
    setElapsed(0);
  }, []);

  const teardown = useCallback(() => {
    cleanup();
    setCall(null);
  }, [cleanup]);

  const getLocalMedia = useCallback(async (type: CallType) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: type === "VIDEO" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
    });
    const preview = localPreviewRef.current;
    stream.getTracks().forEach((track) => preview.addTrack(track));
    rawCameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
    if (localVideoRef.current) localVideoRef.current.srcObject = preview;
    return preview;
  }, []);

  const setLocalVideoTrack = useCallback((track: MediaStreamTrack) => {
    const preview = localPreviewRef.current;
    preview.getVideoTracks().forEach((existing) => preview.removeTrack(existing));
    preview.addTrack(track);
    if (localVideoRef.current) localVideoRef.current.srcObject = preview;
    void videoSenderRef.current?.replaceTrack(track);
  }, []);

  const setupPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pcRef.current = pc;

    localPreviewRef.current.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, localPreviewRef.current);
      if (track.kind === "video") videoSenderRef.current = sender;
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit("call:signal", { callId: callIdRef.current, to: peerIdRef.current, data: { candidate: event.candidate.toJSON() } });
      }
    };

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        if (!remoteStreamRef.current.getTracks().some((existing) => existing.id === track.id)) {
          remoteStreamRef.current.addTrack(track);
        }
      });
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        setError(pc.connectionState === "failed" ? "Connection lost" : "");
      }
    };

    return pc;
  }, [socket]);

  const processSignal = useCallback(
    async (payload: SignalPayload) => {
      const pc = pcRef.current;
      if (!pc) return;
      const { data, from } = payload;
      if (data.description) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        for (const candidate of pendingCandidatesRef.current) await pc.addIceCandidate(candidate).catch(() => {});
        pendingCandidatesRef.current = [];
        if (data.description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket?.emit("call:signal", { callId: callIdRef.current, to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(data.candidate).catch(() => {});
        } else {
          pendingCandidatesRef.current.push(data.candidate);
        }
      }
    },
    [socket]
  );

  const drainSignals = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (pcRef.current && signalQueueRef.current.length > 0) {
        const next = signalQueueRef.current.shift()!;
        await processSignal(next);
      }
    } finally {
      drainingRef.current = false;
    }
  }, [processSignal]);

  const hangUp = useCallback(() => {
    if (callIdRef.current && socket) {
      const state = call?.state;
      if (state === "outgoing") socket.emit("call:cancel", { callId: callIdRef.current });
      else socket.emit("call:end", { callId: callIdRef.current });
    }
    teardown();
  }, [call?.state, socket, teardown]);

  const startCall = useCallback(
    async (conversationId: string, type: CallType, peer: User) => {
      if (!socket || call) return;
      setError("");
      callTypeRef.current = type;
      peerIdRef.current = peer.id;
      setCall({ state: "outgoing", callId: "", type, peer });
      try {
        await getLocalMedia(type);
      } catch {
        setError("Camera/microphone permission denied");
        teardown();
        return;
      }
      socket.emit(
        "call:invite",
        { conversationId, type },
        (res: { callId: string; iceServers: RTCIceServer[] } | { error: string }) => {
          if ("error" in res) {
            setError(res.error);
            teardown();
            return;
          }
          callIdRef.current = res.callId;
          iceServersRef.current = res.iceServers?.length ? res.iceServers : FALLBACK_ICE;
          setCall((current) => (current ? { ...current, callId: res.callId } : current));
        }
      );
    },
    [socket, call, getLocalMedia, teardown]
  );

  const acceptCall = useCallback(async () => {
    if (!socket || !call || call.state !== "incoming") return;
    setError("");
    try {
      await getLocalMedia(call.type);
    } catch {
      setError("Camera/microphone permission denied");
      socket.emit("call:reject", { callId: call.callId });
      teardown();
      return;
    }
    socket.emit("call:accept", { callId: call.callId }, (res: { iceServers: RTCIceServer[] } | { error: string }) => {
      if ("error" in res) {
        setError(res.error);
        teardown();
        return;
      }
      iceServersRef.current = res.iceServers?.length ? res.iceServers : FALLBACK_ICE;
      setupPeerConnection();
      setCall((current) => (current ? { ...current, state: "active" } : current));
      void drainSignals();
    });
  }, [socket, call, getLocalMedia, setupPeerConnection, drainSignals, teardown]);

  const rejectCall = useCallback(() => {
    if (socket && call) socket.emit("call:reject", { callId: call.callId });
    teardown();
  }, [socket, call, teardown]);

  // Socket wiring for call lifecycle + signaling.
  useEffect(() => {
    if (!socket) return;

    const onIncoming = (incoming: IncomingCall) => {
      if (call || callIdRef.current) {
        socket.emit("call:reject", { callId: incoming.id });
        return;
      }
      callIdRef.current = incoming.id;
      peerIdRef.current = incoming.caller.id;
      callTypeRef.current = incoming.type;
      setCall({ state: "incoming", callId: incoming.id, type: incoming.type, peer: incoming.caller });
    };

    const onAccepted = async ({ callId }: { callId: string }) => {
      if (callId !== callIdRef.current) return;
      setCall((current) => (current ? { ...current, state: "active" } : current));
      const pc = setupPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("call:signal", { callId, to: peerIdRef.current, data: { description: pc.localDescription } });
      void drainSignals();
    };

    const onSignal = (payload: SignalPayload) => {
      if (payload.callId !== callIdRef.current) return;
      signalQueueRef.current.push(payload);
      void drainSignals();
    };

    const onRejected = () => {
      setError("Call declined");
      teardown();
    };
    const onCanceled = () => teardown();
    const onEnded = () => teardown();

    socket.on("call:incoming", onIncoming);
    socket.on("call:accepted", onAccepted);
    socket.on("call:signal", onSignal);
    socket.on("call:rejected", onRejected);
    socket.on("call:canceled", onCanceled);
    socket.on("call:ended", onEnded);

    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:accepted", onAccepted);
      socket.off("call:signal", onSignal);
      socket.off("call:rejected", onRejected);
      socket.off("call:canceled", onCanceled);
      socket.off("call:ended", onEnded);
    };
  }, [socket, call, setupPeerConnection, drainSignals, teardown]);

  // Elapsed timer while connected.
  useEffect(() => {
    if (call?.state !== "active") return;
    const handle = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(handle);
  }, [call?.state]);

  // Bind streams to <video> when the overlay mounts.
  useEffect(() => {
    if (call && localVideoRef.current) localVideoRef.current.srcObject = localPreviewRef.current;
    if (call && remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStreamRef.current;
  }, [call]);

  // Auto-clear transient error toasts.
  useEffect(() => {
    if (!error) return;
    const handle = window.setTimeout(() => setError(""), 4000);
    return () => window.clearTimeout(handle);
  }, [error]);

  function toggleMute() {
    const track = localPreviewRef.current.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }

  function toggleCamera() {
    const track = localPreviewRef.current.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
  }

  async function switchCamera() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      if (cameras.length < 2) return;
      const current = rawCameraTrackRef.current?.getSettings().deviceId;
      const next = cameras.find((camera) => camera.deviceId !== current) ?? cameras[0];
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: next.deviceId } } });
      const track = stream.getVideoTracks()[0];
      rawCameraTrackRef.current?.stop();
      rawCameraTrackRef.current = track;
      if (!sharing && !blurOn) setLocalVideoTrack(track);
    } catch {
      setError("Unable to switch camera");
    }
  }

  async function toggleScreenShare() {
    if (sharing) {
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setSharing(false);
      if (rawCameraTrackRef.current) setLocalVideoTrack(rawCameraTrackRef.current);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = () => {
        screenStreamRef.current = null;
        setSharing(false);
        if (rawCameraTrackRef.current) setLocalVideoTrack(rawCameraTrackRef.current);
      };
      setLocalVideoTrack(track);
      setSharing(true);
    } catch {
      setError("Screen share canceled");
    }
  }

  async function toggleBlur() {
    if (blurOn) {
      blurHandleRef.current?.stop();
      blurHandleRef.current = null;
      setBlurOn(false);
      if (rawCameraTrackRef.current) setLocalVideoTrack(rawCameraTrackRef.current);
      return;
    }
    if (!rawCameraTrackRef.current) return;
    try {
      const handle = await createBlurredTrack(rawCameraTrackRef.current);
      blurHandleRef.current = handle;
      setLocalVideoTrack(handle.track);
      setBlurOn(true);
    } catch {
      setError("Background blur unavailable");
    }
  }

  function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const mixed = new MediaStream();
    remoteStreamRef.current.getTracks().forEach((track) => mixed.addTrack(track));
    localPreviewRef.current.getAudioTracks().forEach((track) => mixed.addTrack(track));
    if (mixed.getTracks().length === 0) {
      setError("Nothing to record yet");
      return;
    }
    try {
      const recorder = new MediaRecorder(mixed, { mimeType: pickRecorderMime() });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType });
        setRecording(false);
        if (blob.size > 0 && callIdRef.current) void api.uploadRecording(token, callIdRef.current, blob).catch(() => {});
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError("Recording not supported");
    }
  }

  return (
    <CallContext.Provider value={{ startCall, inCall: Boolean(call) }}>
      {children}
      {call && (
        <CallOverlay
          call={call}
          self={self}
          elapsed={elapsed}
          muted={muted}
          cameraOff={cameraOff}
          sharing={sharing}
          blurOn={blurOn}
          recording={recording}
          error={error}
          localVideoRef={localVideoRef}
          remoteVideoRef={remoteVideoRef}
          onAccept={acceptCall}
          onReject={rejectCall}
          onHangUp={hangUp}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
          onSwitchCamera={switchCamera}
          onToggleScreenShare={toggleScreenShare}
          onToggleBlur={toggleBlur}
          onToggleRecording={toggleRecording}
        />
      )}
    </CallContext.Provider>
  );
}

function CallOverlay({
  call,
  self,
  elapsed,
  muted,
  cameraOff,
  sharing,
  blurOn,
  recording,
  error,
  localVideoRef,
  remoteVideoRef,
  onAccept,
  onReject,
  onHangUp,
  onToggleMute,
  onToggleCamera,
  onSwitchCamera,
  onToggleScreenShare,
  onToggleBlur,
  onToggleRecording
}: {
  call: ActiveCall;
  self: User;
  elapsed: number;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
  blurOn: boolean;
  recording: boolean;
  error: string;
  localVideoRef: React.RefObject<HTMLVideoElement | null>;
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>;
  onAccept: () => void;
  onReject: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleBlur: () => void;
  onToggleRecording: () => void;
}) {
  const isVideo = call.type === "VIDEO";
  const statusLabel =
    call.state === "incoming"
      ? `Incoming ${isVideo ? "video" : "voice"} call`
      : call.state === "outgoing"
        ? "Calling…"
        : formatDuration(elapsed);

  return (
    <div className={`call-overlay ${call.state}`}>
      <div className="call-stage">
        {isVideo && <video ref={remoteVideoRef} className="call-remote" autoPlay playsInline />}
        {(!isVideo || call.state !== "active") && (
          <div className="call-poster">
            <Avatar user={call.peer} />
            <h2>{call.peer.displayName}</h2>
            <p>{statusLabel}</p>
          </div>
        )}
        {isVideo && call.state === "active" && (
          <div className="call-banner">
            <strong>{call.peer.displayName}</strong>
            <span>{statusLabel}</span>
          </div>
        )}
        <video ref={localVideoRef} className={`call-local ${isVideo ? "" : "hidden"}`} autoPlay playsInline muted />
        {recording && <span className="call-recording-dot">● REC</span>}
        {error && <div className="call-error">{error}</div>}
      </div>

      <div className="call-controls">
        {call.state === "incoming" ? (
          <>
            <button className="call-button accept" onClick={onAccept} title="Accept">
              <Phone size={22} />
            </button>
            <button className="call-button hangup" onClick={onReject} title="Decline">
              <PhoneOff size={22} />
            </button>
          </>
        ) : (
          <>
            <button className={`call-button ${muted ? "off" : ""}`} onClick={onToggleMute} title={muted ? "Unmute" : "Mute"}>
              {muted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            {isVideo && (
              <>
                <button className={`call-button ${cameraOff ? "off" : ""}`} onClick={onToggleCamera} title={cameraOff ? "Camera on" : "Camera off"}>
                  {cameraOff ? <VideoOff size={20} /> : <Video size={20} />}
                </button>
                <button className="call-button" onClick={onSwitchCamera} title="Switch camera">
                  <SwitchCamera size={20} />
                </button>
                <button className={`call-button ${sharing ? "active" : ""}`} onClick={onToggleScreenShare} title="Share screen">
                  <MonitorUp size={20} />
                </button>
                <button className={`call-button ${blurOn ? "active" : ""}`} onClick={onToggleBlur} title="Background blur">
                  <Sparkles size={20} />
                </button>
              </>
            )}
            <button className={`call-button ${recording ? "active" : ""}`} onClick={onToggleRecording} title={recording ? "Stop recording" : "Record call"}>
              <Disc size={20} />
            </button>
            <button className="call-button hangup" onClick={onHangUp} title="End call">
              <PhoneOff size={22} />
            </button>
          </>
        )}
      </div>
      <p className="call-self-tag">You · {self.displayName}</p>
    </div>
  );
}

function Avatar({ user }: { user: User }) {
  const initials = user.displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return user.avatarUrl ? <img className="avatar call-avatar" src={user.avatarUrl} alt="" /> : <div className="avatar call-avatar">{initials}</div>;
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function pickRecorderMime() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "audio/webm"];
  return candidates.find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "video/webm";
}
