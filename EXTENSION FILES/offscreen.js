// Ensure ONNX Runtime looks for WASM files in the lib directory
ort.env.wasm.wasmPaths = {
    'ort-wasm.wasm': chrome.runtime.getURL('lib/ort-wasm.wasm'),
    'ort-wasm-simd.wasm': chrome.runtime.getURL('lib/ort-wasm-simd.wasm')
};
// Disable multithreading because we didn't download the threaded WASM files
ort.env.wasm.numThreads = 1;

let session = null;
let inferenceThreshold = 0.5;
const canvas = document.getElementById('preprocessCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

async function loadInferenceConfig() {
    try {
        const response = await fetch(chrome.runtime.getURL('models/inference_config.json'));
        if (!response.ok) {
            return;
        }

        const config = await response.json();
        if (Number.isFinite(config.threshold)) {
            inferenceThreshold = config.threshold;
            console.log(`Using calibrated threshold: ${inferenceThreshold}`);
        }
    } catch (error) {
        console.warn('Inference config unavailable; using threshold 0.5.', error);
    }
}

async function loadModel() {
    if (!session) {
        console.log("Loading ONNX model...");
        try {
            const modelUrl = chrome.runtime.getURL('models/FinalModel.onnx');
            session = await ort.InferenceSession.create(modelUrl);
            console.log("ONNX model loaded successfully.");
        } catch (e) {
            console.error("Failed to load ONNX model", e);
            throw e;
        }
    }
    await loadInferenceConfig();
    return session;
}

// Convert image data to the Float32 tensor format with ImageNet normalization
function preprocess(imageData) {
    const data = imageData.data;
    const float32Data = new Float32Array(3 * 224 * 224);

    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];

    // Convert RGBA [0,255] to RGB, apply PyTorch ImageNet mean/std, transpose to [3, 224, 224]
    for (let i = 0; i < 224 * 224; i++) {
        // Red
        float32Data[i] = ((data[i * 4] / 255.0) - mean[0]) / std[0];
        // Green
        float32Data[i + 224 * 224] = ((data[i * 4 + 1] / 255.0) - mean[1]) / std[1];
        // Blue
        float32Data[i + 2 * 224 * 224] = ((data[i * 4 + 2] / 255.0) - mean[2]) / std[2];
    }

    return new ort.Tensor('float32', float32Data, [1, 3, 224, 224]);
}

async function processFrame(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = async () => {
            ctx.clearRect(0, 0, 224, 224);
            ctx.drawImage(img, 0, 0, 224, 224);
            const imageData = ctx.getImageData(0, 0, 224, 224);
            const inputTensor = preprocess(imageData);
            
            try {
                const outputMap = await session.run({ 'input.1': inputTensor });
                const outputKey = session.outputNames[0];
                // FinalModel already applies sigmoid during ONNX export.
                resolve(outputMap[outputKey].data[0]);
            } catch (err) {
                console.error("Inference error:", err);
                resolve(null);
            }
        };
        img.onerror = (e) => resolve(null);
        img.src = dataUrl.startsWith('data:image') ? dataUrl : 'data:image/jpeg;base64,' + dataUrl;
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target === 'offscreen') {
        if (request.action === 'analyzeFrames') {
            handleAnalyzeFrames(request.frames, request.metadata)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ error: err.message }));
            return true;
        }
    }
});

async function handleAnalyzeFrames(frames, metadata) {
    const tabId = metadata ? metadata.tabId : null;

    if (tabId) {
        chrome.runtime.sendMessage({
            target: 'background',
            action: 'updateProgress',
            tabId: tabId,
            current: 0,
            total: frames.length,
            message: "Loading ONNX model into browser memory..."
        }).catch(() => {});
    }

    await loadModel();
    
    const startTime = performance.now();
    const predictionValues = [];
    
    for (let i = 0; i < frames.length; i++) {
        const prediction = await processFrame(frames[i]);
        if (prediction !== null) {
            predictionValues.push(prediction);
        }
        
        if (tabId) {
            chrome.runtime.sendMessage({
                target: 'background',
                action: 'updateProgress',
                tabId: tabId,
                current: i + 1,
                total: frames.length,
                message: `Running ONNX Inference: Frame ${i + 1} of ${frames.length}`
            }).catch(() => {});
        }
    }
    
    if (predictionValues.length === 0) {
        throw new Error("No frames could be analyzed");
    }
    
    // Model training uses fake=1 and real=0.
    const threshold = inferenceThreshold;
    const deepfakeFrames = predictionValues.filter(p => p > threshold).length;
    const totalProcessed = predictionValues.length;
    const avgProb = predictionValues.reduce((a, b) => a + b, 0) / totalProcessed;
    const isDeepfake = avgProb > threshold;
    let confidence = Math.abs(avgProb - threshold) * 2;
    confidence = Math.min(1.0, confidence);
    
    const processingTimeMs = performance.now() - startTime;
    
    return {
        deepfake: isDeepfake,
        confidence: confidence,
        avg_prediction: avgProb,
        deepfake_frames: deepfakeFrames,
        frames_analyzed: totalProcessed,
        processing_time_ms: processingTimeMs,
        status: "success"
    };
}
