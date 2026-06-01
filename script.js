const SERVER_URL = 'wss://cbp-signaling.onrender.com';
let wsDirector, wsCamera;
let peerConnections = {};
let connectedCount = 0;
let localMediaStream;
let pcCam;
let activeLiveStreamId = null;
let renderOverlayActive = true;
let isCloudStreamingActive = false;
let mediaRecorder = null; 

let currentTargetRatio = "16:9"; 

const canvas = document.getElementById('programCanvas');
const ctx = canvas.getContext('2d');

// ১. ক্যানভাস অ্যাসপেক্ট রেশিও হ্যান্ডলার
function changeOutputAspectRatio() {
    let selector = document.getElementById('canvasRatioSelector');
    currentTargetRatio = selector.value;
    let wrapper = document.getElementById('canvasFrameWrapper');

    wrapper.classList.remove('aspect-video', 'aspect-square', 'aspect-[4/3]', 'aspect-[9/16]');

    if (currentTargetRatio === "16:9") {
        canvas.width = 1280; canvas.height = 720; 
        wrapper.classList.add('aspect-video');
    } else if (currentTargetRatio === "4:3") {
        canvas.width = 960; canvas.height = 720;
        wrapper.classList.add('aspect-[4/3]');
    } else if (currentTargetRatio === "9:16") {
        canvas.width = 720; canvas.height = 1280;
        wrapper.classList.add('aspect-[9/16]');
    } else if (currentTargetRatio === "1:1") {
        canvas.width = 720; canvas.height = 720;
        wrapper.classList.add('aspect-square');
    }
}
changeOutputAspectRatio();

// ২. ওয়ার্কস্পেস সুইচ মেকানিজম
function openWorkspace(mode) {
    document.getElementById('lobbyGate').classList.add('hidden');
    if (mode === 'director') {
        document.getElementById('directorWindow').classList.remove('hidden');
        changeOutputAspectRatio(); 
    } else if (mode === 'camera') {
        document.getElementById('cameraWindow').classList.remove('hidden');
    }
}

function exitToLobby() {
    if(wsDirector) wsDirector.close();
    if(wsCamera) wsCamera.close();
    if(localMediaStream) localMediaStream.getTracks().forEach(track => track.stop());
    window.location.reload(); 
}

// 🎬 ৩. ডিরেক্টর ইঞ্জিন রুম ইনিশিয়েটর
function initiateDirectorRoom() {
    wsDirector = new WebSocket(SERVER_URL);

    wsDirector.onopen = () => {
        wsDirector.send(JSON.stringify({ type: 'create_room' }));
        document.getElementById('createRoomBtn').classList.add('hidden');
        document.getElementById('codeDisplaySection').classList.replace('hidden', 'flex');
    };

    wsDirector.onmessage = async (message) => {
        let data = JSON.parse(message.data);

        if (data.type === 'room_created') {
            document.getElementById('secretCodeBox').innerText = data.roomCode;
        }
        
        else if (data.type === 'camera_joined') {
            let pc = new RTCPeerConnection({
                iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
                rtcAudioJitterBufferMaxPackets: 10,
                bundlePolicy: "max-bundle"
            });
            peerConnections[data.cameraId] = pc;

            connectedCount++;
            document.getElementById('activeCamCount').innerText = `ENGAGED CHANNELS: ${connectedCount}/4`;
            
            document.getElementById(`status-${data.cameraId}`).innerText = "🟢 LIVE";
            document.getElementById(`status-${data.cameraId}`).className = "text-emerald-400 font-bold";
            document.getElementById(`box-${data.cameraId}`).classList.remove('opacity-20', 'scale-95');
            
            document.getElementById(`thumb-${data.cameraId}`).style.display = "none";

            let lastResult;
            let bitrateInterval = setInterval(() => {
                if(!pc || pc.connectionState === 'disconnected') return clearInterval(bitrateInterval);
                pc.getStats(null).then(stats => {
                    stats.forEach(report => {
                        if (report.type === 'inbound-rtp' && report.kind === 'video') {
                            if (lastResult && lastResult.bytesReceived) {
                                let bytes = report.bytesReceived - lastResult.bytesReceived;
                                let kbits = (bytes * 8) / 1000;
                                document.getElementById(`bitrate-${data.cameraId}`).innerText = Math.floor(kbits) + " Kbps";
                            }
                            lastResult = report;
                        }
                    });
                });
            }, 1000);

            pc.ontrack = (event) => {
                let targetVideo = document.getElementById(`v-${data.cameraId}`);
                if (event.streams && event.streams[0]) {
                    targetVideo.srcObject = event.streams[0];
                    targetVideo.load();
                    targetVideo.play().catch(e => console.log(e));
                }
            };

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    wsDirector.send(JSON.stringify({ type: 'ice-candidate', targetId: data.cameraId, candidate: event.candidate }));
                }
            };

            let offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
            await pc.setLocalDescription(offer);
            wsDirector.send(JSON.stringify({ type: 'offer', targetId: data.cameraId, offer }));
        }

        else if (data.type === 'answer') {
            await peerConnections[data.cameraId].setRemoteDescription(new RTCSessionDescription(data.answer));
        }

        else if (data.type === 'ice-candidate' && peerConnections[data.cameraId]) {
            await peerConnections[data.cameraId].addIceCandidate(new RTCIceCandidate(data.candidate));
        }

        else if (data.type === 'disconnect') {
            connectedCount = Math.max(0, connectedCount - 1);
            document.getElementById('activeCamCount').innerText = `ENGAGED CHANNELS: ${connectedCount}/4`;
            document.getElementById(`status-${data.cameraId}`).innerText = "OFFLINE";
            document.getElementById(`status-${data.cameraId}`).className = "text-red-500";
            document.getElementById(`bitrate-${data.cameraId}`).innerText = "0 Kbps";
            
            document.getElementById(`thumb-${data.cameraId}`).style.display = "flex";
            document.getElementById(`box-${data.cameraId}`).className = "border border-slate-800 bg-slate-900 rounded-xl p-2 cursor-pointer opacity-20 scale-95 transition-all duration-300";
            
            if(activeLiveStreamId === data.cameraId) activeLiveStreamId = null;
            document.getElementById(`v-${data.cameraId}`).srcObject = null;
        }
    };
}

// 8. ক্যানভাস চ্যানেল নির্বাচন ম্যানেজার
function selectLiveCamChannel(camId) {
    let targetVideo = document.getElementById(`v-${camId}`);
    if(!targetVideo || !targetVideo.srcObject) return; 

    activeLiveStreamId = camId;
    ['cam1','cam2','cam3','cam4'].forEach(id => {
        document.getElementById(`box-${id}`).classList.remove('border-red-600', 'ring-2', 'ring-red-600/50');
    });
    document.getElementById(`box-${camId}`).classList.add('border-red-600', 'ring-2', 'ring-red-600/50');
}

// 🔥 ৪. ক্লাউড স্ট্রিমিং কন্ট্রোলার (Fixes Bitrate and Audio tracking)
function toggleCloudStreaming() {
    if (!wsDirector || wsDirector.readyState !== 1) return alert("প্রথমে Cloud Network চালু করুন!");
    
    let url = document.getElementById('rtmpUrlInput').value.trim();
    let key = document.getElementById('rtmpKeyInput').value.trim();

    if (!url || !key) return alert("দয়া করে Stream URL এবং Stream Key দুটিই ইনপুট করুন!");

    if (!isCloudStreamingActive) {
        wsDirector.send(JSON.stringify({
            type: 'start_rtmp_stream',
            streamUrl: url,
            streamKey: key
        }));

        isCloudStreamingActive = true;
        document.getElementById('startLiveBtn').innerText = "STOP LIVE STREAM";
        document.getElementById('startLiveBtn').className = "w-full bg-red-600 hover:bg-red-500 text-white text-[10px] font-black py-2.5 rounded-xl uppercase tracking-wider transition animate-pulse";
        document.getElementById('streamIndicator').innerText = "🔴 ON AIR";
        document.getElementById('streamIndicator').className = "text-[9px] bg-red-950 text-red-400 font-bold px-2 py-0.5 rounded border border-red-900 uppercase";

        const canvasStream = canvas.captureStream(30); 
        
        let audioTrackAdded = false;
        if (activeLiveStreamId) {
            let liveVideo = document.getElementById(`v-${activeLiveStreamId}`);
            if (liveVideo && liveVideo.srcObject && liveVideo.srcObject.getAudioTracks().length > 0) {
                canvasStream.addTrack(liveVideo.srcObject.getAudioTracks()[0]);
                audioTrackAdded = true;
            }
        }

        // যদি কোনো ক্যামেরা ট্র্যাকিং অডিও না থাকে তবে সাইড ট্র্যাকিং ব্ল্যাঙ্ক অডিও পুশ করা হচ্ছে
        if (!audioTrackAdded) {
            try {
                let ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
                let silence = ctxAudio.createMediaStreamDestination();
                canvasStream.addTrack(silence.stream.getAudioTracks()[0]);
            } catch(e) {
                console.log("Silent audio setup failed", e);
            }
        }

        // রিকমেন্ডেড বিটরেট ব্যালেন্স লক (ভিডিও: ২.৮ Mbps, অডিও: ১২৮ Kbps)
        const options = {
            mimeType: 'video/webm;codecs=vp8,opus',
            videoBitsPerSecond: 2800000, 
            audioBitsPerSecond: 128000   
        };

        mediaRecorder = new MediaRecorder(canvasStream, options);

        mediaRecorder.ondataavailable = async (event) => {
            if (event.data && event.data.size > 0 && wsDirector.readyState === 1) {
                let arrayBuffer = await event.data.arrayBuffer();
                let base64String = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
                wsDirector.send(JSON.stringify({
                    type: 'binary_frame',
                    frame: base64String
                }));
            }
        };

        // বিটরেট ড্রপ রুখতে বাফার ইন্টারভাল ১ সেকেন্ড (1000ms) করা হলো
        mediaRecorder.start(1000); 

    } else {
        if(mediaRecorder) {
            mediaRecorder.stop();
            mediaRecorder = null;
        }
        wsDirector.send(JSON.stringify({ type: 'stop_rtmp_stream' }));

        isCloudStreamingActive = false;
        document.getElementById('startLiveBtn').innerText = "GO LIVE ON YT/FB";
        document.getElementById('startLiveBtn').className = "w-full bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-black py-2.5 rounded-xl uppercase tracking-wider transition";
        document.getElementById('streamIndicator').innerText = "OFF AIR";
        document.getElementById('streamIndicator').className = "text-[9px] bg-slate-900 text-slate-500 font-bold px-2 py-0.5 rounded border border-slate-800 uppercase";
    }
}

// 🎚️ ৫. স্কোরবোর্ড ওভারলে ও গ্রাফিক্স ইঞ্জিন 
function toggleScoreboardOverlay() {
    renderOverlayActive = !renderOverlayActive;
    document.getElementById('overlaySwitchBtn').innerText = renderOverlayActive ? "Graphics: ON" : "Graphics: OFF";
    document.getElementById('overlaySwitchBtn').className = renderOverlayActive ? "bg-blue-600 text-[10px] font-black px-3 py-1 rounded-lg uppercase transition" : "bg-slate-800 text-[10px] font-black px-3 py-1 rounded-lg uppercase transition text-slate-400";
}

function drawVideoWithAspectRatio(videoEl, canvasCtx, canvasW, canvasH) {
    let videoW = videoEl.videoWidth || videoEl.width;
    let videoH = videoEl.videoHeight || videoEl.height;
    if (!videoW || !videoH) { videoW = 1280; videoH = 720; }
    let canvasRatio = canvasW / canvasH;
    let videoRatio = videoW / videoH;
    let renderW, renderH, xOffset, yOffset;

    if (videoRatio > canvasRatio) {
        renderW = canvasW; renderH = canvasW / videoRatio;
        xOffset = 0; yOffset = (canvasH - renderH) / 2;
    } else {
        renderH = canvasH; renderW = canvasH * videoRatio;
        xOffset = (canvasW - renderW) / 2; yOffset = 0;
    }
    canvasCtx.fillStyle = '#000000';
    canvasCtx.fillRect(0, 0, canvasW, canvasH);
    try { canvasCtx.drawImage(videoEl, xOffset, yOffset, renderW, renderH); } catch (e) {}
}

function renderBroadcastPipeline() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (activeLiveStreamId) {
        let liveVideo = document.getElementById(`v-${activeLiveStreamId}`);
        if (liveVideo && (liveVideo.readyState >= 2 || liveVideo.srcObject)) {
            drawVideoWithAspectRatio(liveVideo, ctx, canvas.width, canvas.height);
        }
    } else {
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#334155';
        ctx.font = 'bold 24px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText('SELECT AN ACTIVE CAMERA CHANNEL BELOW TO STREAM LIVE', canvas.width / 2, canvas.height / 2);
    }

    if (renderOverlayActive) {
        ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
        let baseOffset = (currentTargetRatio === "9:16") ? 25 : 60;
        let barWidth = (currentTargetRatio === "9:16" || currentTargetRatio === "1:1") ? canvas.width - (baseOffset * 2) : 720;

        ctx.fillStyle = 'rgba(244, 63, 94, 0.9)'; 
        ctx.fillRect(baseOffset, 40, (currentTargetRatio === "9:16" ? 220 : 260), 32);
        ctx.fillStyle = '#ffffff';
        ctx.font = (currentTargetRatio === "9:16") ? 'bold 11px sans-serif' : 'bold 13px sans-serif';
        ctx.fillText(document.getElementById('sponsorInput').value.toUpperCase(), baseOffset + 15, 61);

        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)'; 
        ctx.fillRect(baseOffset, canvas.height - 100, barWidth, 55);
        ctx.fillStyle = '#fbbf24'; ctx.fillRect(baseOffset, canvas.height - 100, 6, 55);

        ctx.fillStyle = '#ffffff';
        ctx.font = (currentTargetRatio === "9:16") ? 'bold 18px monospace' : 'bold 26px monospace';
        ctx.fillText(document.getElementById('scoreInput').value, baseOffset + 25, canvas.height - 63);

        if (currentTargetRatio === "9:16") {
            ctx.fillStyle = '#94a3b8'; ctx.font = 'bold 12px sans-serif';
            ctx.fillText(document.getElementById('oversInput').value.toUpperCase(), baseOffset + 180, canvas.height - 80);
            ctx.fillStyle = '#e2e8f0'; ctx.font = 'italic 12px sans-serif';
            ctx.fillText(document.getElementById('batsmanInput').value, baseOffset + 180, canvas.height - 63);
        } else {
            ctx.fillStyle = '#94a3b8'; ctx.font = 'bold 16px sans-serif';
            ctx.fillText(document.getElementById('oversInput').value.toUpperCase(), baseOffset + 240, canvas.height - 64);
            ctx.fillStyle = '#3b82f6'; ctx.fillRect(baseOffset + 400, canvas.height - 90, 2, 35);
            ctx.fillStyle = '#e2e8f0'; ctx.font = 'italic 18px sans-serif';
            ctx.fillText(document.getElementById('batsmanInput').value, baseOffset + 420, canvas.height - 64);
        }
    }
    requestAnimationFrame(renderBroadcastPipeline);
}
renderBroadcastPipeline();

// 📱 6. ফিল্ড ক্যামেরা আপলিংক নোড ট্রান্সমিটার
async function activateFieldCameraNode() {
    let codeInput = document.getElementById('studioRoomCode').value.trim().toUpperCase();
    if(!codeInput) return alert("দয়া করে সিক্রেট কোডটি টাইপ বা পেস্ট করুন!");
    try {
        localMediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 }, aspectRatio: { ideal: 1.777777778 }, facingMode: "environment" },
            audio: true 
        });
    } catch (err) { return alert("ক্যামেরা অন করা যায়নি!"); }

    wsCamera = new WebSocket(SERVER_URL);
    wsCamera.onopen = () => wsCamera.send(JSON.stringify({ type: 'join_room', roomCode: codeInput }));
    wsCamera.onmessage = async (message) => {
        let data = JSON.parse(message.data);
        if (data.type === 'joined_successfully') {
            document.getElementById('joinGateWindow').classList.add('hidden');
            document.getElementById('streamingActiveWindow').classList.remove('hidden');
            document.getElementById('assignedNodeName').innerText = `UPLINK ACTIVE AS: ${data.cameraId.toUpperCase()}`;
            document.getElementById('localCamMonitor').srcObject = localMediaStream;
        }
        else if (data.type === 'offer') {
            pcCam = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
            localMediaStream.getTracks().forEach(track => {
                let sender = pcCam.addTrack(track, localMediaStream);
                if (track.kind === 'video') {
                    let params = sender.getParameters();
                    if (!params.encodings) params.encodings = [{}];
                    params.encodings[0].maxBitrate = 2000000; 
                    sender.setParameters(params);
                }
            });
            pcCam.onicecandidate = (e) => {
                if (e.candidate) wsCamera.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate }));
            };
            await pcCam.setRemoteDescription(new RTCSessionDescription(data.offer));
            let answer = await pcCam.createAnswer();
            await pcCam.setLocalDescription(answer);
            wsCamera.send(JSON.stringify({ type: 'answer', answer }));
        }
        else if (data.type === 'ice-candidate' && pcCam) {
            await pcCam.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    };
                            }
                      
