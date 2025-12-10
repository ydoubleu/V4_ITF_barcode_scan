import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BrowserMultiFormatReader, BarcodeFormat, DecodeHintType } from '@zxing/library';
import { AlertCircle, Scan, Camera } from 'lucide-react';

interface ScannerProps {
  onScan: (result: string, format: string) => void;
  onError: (error: string) => void;
  isPaused: boolean;
}

// Camera Device Interface
interface VideoInput {
  deviceId: string;
  label: string;
}

// React.memo: Prevents unnecessary re-renders
export const Scanner = React.memo<ScannerProps>(({ onScan, onError, isPaused }) => {
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);

  // Camera State
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [activeCameraLabel, setActiveCameraLabel] = useState<string>('');
  const [availableCameras, setAvailableCameras] = useState<VideoInput[]>([]);
  const [isSwitching, setIsSwitching] = useState(false);
  const [resolutionDebug, setResolutionDebug] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const codeReaderRef = useRef<BrowserMultiFormatReader | null>(null);

  const activeRef = useRef<boolean>(!isPaused);
  const isBusyRef = useRef<boolean>(false);

  useEffect(() => {
    activeRef.current = !isPaused;
  }, [isPaused]);

  // Toast Timer Ref
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastMessage(message);
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2000);
  };

  // 1. Initialize Decoder Engine (ZXing)
  useEffect(() => {
    const hints = new Map<DecodeHintType, any>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.ITF]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    codeReaderRef.current = new BrowserMultiFormatReader(hints);

    return () => {
      codeReaderRef.current = null;
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  // 2. Discover Cameras
  const refreshDeviceList = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices
        .filter(d => d.kind === 'videoinput')
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 5)}...` }));

      // Filter out front cameras if possible (usually contain 'front' or 'selfie')
      // But rely mostly on just listing them. User can switch.
      // Prioritize Back cameras.
      const backCameras = videoInputs.filter(d =>
        d.label.toLowerCase().includes('back') ||
        d.label.toLowerCase().includes('environment') ||
        d.label.toLowerCase().includes('rear')
      );

      setAvailableCameras(backCameras.length > 0 ? backCameras : videoInputs);
    } catch (e) {
      console.error("Failed to list devices", e);
    }
  }, []);

  // 3. Start Camera Function
  const startCamera = useCallback(async (deviceId?: string) => {
    setIsSwitching(true);
    let currentStream = streamRef.current;

    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }

    try {
      let constraints: MediaStreamConstraints = {
        audio: false,
        video: {
          // Resolution Strategy: Try FHD (1080p) first, fallback handled in catch or by browser
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // If deviceId is provided, use it exactly. Otherwise prefer environment.
          deviceId: deviceId ? { exact: deviceId } : undefined,
          facingMode: deviceId ? undefined : 'environment'
        }
      };

      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.warn("FHD failed, trying HD...");
        // Fallback: 720p
        constraints.video = {
          ...constraints.video as MediaTrackConstraints,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      }

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(e => console.error("Play error", e));
        };
      }

      setHasCameraPermission(true);

      // Refresh device list now that we have permissions (labels will be visible)
      refreshDeviceList();

      const track = stream.getVideoTracks()[0];
      videoTrackRef.current = track;

      // --- Persistence & State Update ---
      const activeId = track.getSettings().deviceId;
      if (activeId) {
        setActiveDeviceId(activeId);
        localStorage.setItem('scanner_last_device_id', activeId);

        // Update Label
        let label = track.label || 'Unknown Camera';

        // Translate and Clean Label
        label = label
          .replace(/facing back/i, '후면')
          .replace(/facing front/i, '전면')
          .replace(/camera/i, '카메라')
          .replace(/back/i, '후면')
          .replace(/front/i, '전면');

        setActiveCameraLabel(label);

        // Only show toast if switching (not initial load if possible, but hard to distinguish here easily. 
        // We can check if isSwitching is true, but it is always true inside this function.
        // Let's just always show it on successful start, it confirms "Camera Ready"
        showToast(`📷 ${label}`);
      }

      // --- Auto Zoom (Optimization) ---
      // Apply ~2.0x zoom automatically if supported
      const cap = track.getCapabilities() as any;
      if (cap.zoom) {
        const targetZoom = Math.min(Math.max(2.0, cap.zoom.min), cap.zoom.max);
        try {
          await track.applyConstraints({ advanced: [{ zoom: targetZoom }] } as any);
          console.log(`Auto-zoom applied: ${targetZoom}x`);
        } catch (e) {
          console.warn("Zoom apply failed", e);
        }
      }

      // --- Auto Focus ---
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
      } catch (e) { }

      // --- Debug Info ---
      const set = track.getSettings();
      setResolutionDebug(`${set.width}x${set.height}`);

      // Handle Unexpected Stop
      track.onended = () => {
        console.warn("Track ended, restarting...");
        startCamera(); // Re-trigger auto selection or saved ID
      };

    } catch (err) {
      console.error("Camera Error", err);
      setHasCameraPermission(false);
      onError("카메라를 실행할 수 없습니다. (권한/하드웨어)");
    } finally {
      setIsSwitching(false);
    }
  }, [onError, refreshDeviceList]);

  // 4. Initial Mount
  useEffect(() => {
    const savedId = localStorage.getItem('scanner_last_device_id');
    // If we have a saved ID, try to check if it still exists (optional, but good)
    // For now, just try to use it. getUserMedia will fail if invalid, we can catch that?
    // actually, let's just "Start" with savedId if present.

    startCamera(savedId || undefined);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Check if dead
        const track = streamRef.current?.getVideoTracks()[0];
        if (!track || track.readyState === 'ended' || track.muted) {
          startCamera(activeDeviceId || undefined);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []); // Run once on mount

  // 5. Decoding Loop
  useEffect(() => {
    if (!hasCameraPermission || !codeReaderRef.current) return;

    const loop = async () => {
      animationFrameRef.current = requestAnimationFrame(loop);

      if (!activeRef.current || isBusyRef.current || isSwitching) return;

      const video = videoRef.current;
      if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

      try {
        isBusyRef.current = true;
        // @ts-ignore
        const result = await codeReaderRef.current.decode(video);
        if (activeRef.current && result) {
          onScan(result.getText(), result.getBarcodeFormat().toString());
        }
      } catch (err) {
        // No code found
      } finally {
        isBusyRef.current = false;
      }
    };
    loop();
    return () => { if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current); };
  }, [hasCameraPermission, onScan, isSwitching]);

  // 6. Manual Switch Handler
  const handleSwitchCamera = () => {
    if (availableCameras.length < 2) return;

    const currentIndex = availableCameras.findIndex(c => c.deviceId === activeDeviceId);
    const nextIndex = (currentIndex + 1) % availableCameras.length;
    const nextDevice = availableCameras[nextIndex];

    startCamera(nextDevice.deviceId);
  };

  if (hasCameraPermission === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-red-400 p-6 text-center bg-slate-900">
        <AlertCircle size={48} className="mb-4" />
        <p className="text-lg font-semibold">카메라 오류</p>
        <button onClick={() => window.location.reload()} className="mt-4 bg-slate-700 px-4 py-2 rounded">새로고침</button>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black flex flex-col overflow-hidden">
      <video
        ref={videoRef}
        className="w-full h-full object-cover"
        muted
        playsInline
        autoPlay
      />

      {/* Scan Guide Overlay */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 transition-all duration-300">
        {/* Laser Line */}
        <div className="absolute w-0.5 h-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.8)]"></div>

        {/* Box - Portrait Size (Optimized for mobile) */}
        <div className="w-[140px] h-[240px] border-2 border-white/40 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] box-border relative">
          <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-emerald-400 -mt-0.5 -ml-0.5"></div>
          <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-emerald-400 -mt-0.5 -mr-0.5"></div>
          <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-emerald-400 -mb-0.5 -ml-0.5"></div>
          <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-emerald-400 -mb-0.5 -mr-0.5"></div>
        </div>
      </div>

      {/* Toast Notification */}
      {toastMessage && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-40 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="bg-black/70 backdrop-blur-md text-white text-xs px-4 py-2 rounded-full border border-white/10 shadow-lg flex items-center gap-2">
            <span>{toastMessage}</span>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <div className="absolute bottom-6 right-6 z-30 flex flex-col gap-4">
        {availableCameras.length > 1 && (
          <button
            onClick={handleSwitchCamera}
            disabled={isSwitching}
            className="bg-black/50 backdrop-blur-md text-white p-3 rounded-full border border-white/20 active:bg-emerald-600/50 transition-all shadow-lg"
          >
            <Camera size={24} className={isSwitching ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {/* Top Info */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none z-20 whitespace-nowrap opacity-80">
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1 text-[10px] text-white/90 bg-black/60 px-3 py-1 rounded-full backdrop-blur-sm border border-white/10">
            <Scan size={12} className="text-emerald-400" />
            <span>ITF 스캔 ({resolutionDebug})</span>
          </div>
          {activeCameraLabel && (
            <span className="text-[9px] text-zinc-400 bg-black/40 px-2 py-0.5 rounded text-shadow">
              {activeCameraLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});