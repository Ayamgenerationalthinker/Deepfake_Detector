// VeriGuard background script

// Keeping track of analysis history
let analysisHistory = [];

// Separate function to register context menus
function registerContextMenus() {
  // Removing any existing menus to prevent duplicates
  chrome.contextMenus.removeAll(() => {
    console.log("Cleared existing context menus");
    
    // Creating a single context menu item that appears for videos and pages
    chrome.contextMenus.create({
      id: "analyze-media",
      title: "Analyze with VeriGuard",
      contexts: ["video", "page"] 
    }, function() {
      if (chrome.runtime.lastError) {
        console.error("Error creating menu:", chrome.runtime.lastError.message);
      } else {
        console.log("VeriGuard context menu created successfully");
      }
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    if (!tabId) {
      console.warn("Cannot send message - no valid tab ID provided");
      return reject(new Error("No valid tab ID"));
    }
    
    // Checking if the tab exists first
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        console.warn(`Tab ${tabId} doesn't exist:`, chrome.runtime.lastError.message);
        return reject(new Error(`Tab ${tabId} doesn't exist`));
      }
      
    
      chrome.tabs.sendMessage(tabId, message, response => {
        if (chrome.runtime.lastError) {
     
          console.log(`Message failed, will try injecting content script first: ${chrome.runtime.lastError.message}`);
          
      
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          }).then(() => {
            // Giving the content script a moment to initialize
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, message, secondResponse => {
                if (chrome.runtime.lastError) {
                  console.error(`Failed even after injecting content script: ${chrome.runtime.lastError.message}`);
                  reject(chrome.runtime.lastError);
                } else {
                  resolve(secondResponse);
                }
              });
            }, 500);
          }).catch(err => {
            console.error("Failed to inject content script:", err);
            reject(err);
          });
        } else {
  
          resolve(response);
        }
      });
    });
  });
}

function loadAnalysisHistoryFromStorage(callback) {
  chrome.storage.local.get(['analysisHistory'], (result) => {
    if (Array.isArray(result.analysisHistory)) {
      analysisHistory = result.analysisHistory;
    } else {
      analysisHistory = [];
      chrome.storage.local.set({analysisHistory: []});
    }
    if (typeof callback === 'function') {
      callback();
    }
  });
}

// Registering context menus when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  console.log("VeriGuard extension installed");
  registerContextMenus();
  loadAnalysisHistoryFromStorage();
});

// Registering context menus when browser starts
chrome.runtime.onStartup.addListener(() => {
  console.log("Browser started - reinstalling context menus");
  registerContextMenus();
  loadAnalysisHistoryFromStorage();
});

// For keyboard shortcut for analysis
chrome.commands.onCommand.addListener((command) => {
  console.log("Command received:", command);
  if (command === "analyze-current-video") {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs.length > 0) {
        console.log("Keyboard shortcut: analyzing video in current tab");
        analyzeCurrentVideo(tabs[0].id);
      }
    });
  }
});


function notifyUser(tabId, type, message) {
  if (!tabId) {
    console.warn("Cannot notify - no valid tab ID");
    return;
  }
  
  sendMessageToTab(tabId, { action: "showNotification", type, message })
    .catch(error => {
      console.warn(`Notification to tab ${tabId} failed: ${error.message}`);
    
    });
}

// Handling context menu clicks 
chrome.contextMenus.onClicked.addListener((info, tab) => {
  console.log("Menu clicked:", info.menuItemId); // Add logging for debugging
  
  // Making sure tab exists before trying to access tab.id
  if (!tab) {
    console.error("Tab is undefined in onClicked handler");
    return;
  }
  
  // Simplified menu handler 
  if (info.menuItemId === "analyze-media") {
    console.log("Analyzing media in tab:", tab.id);
    analyzeCurrentVideo(tab.id);
  }
});

// Improving background script message handling
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "analyzeUploadedFrames") {
    analyzeUploadedFrames(msg.frames, msg.fileName)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message || "Upload analysis failed" }));
    return true;
  }

  // Handling messages for video analysis
  if (msg.action === "analyzeCurrentVideo") {
   
    if (msg.tabId) {
      analyzeCurrentVideo(msg.tabId);
      sendResponse({success: true});
    } 
  
    else if (sender && sender.tab && sender.tab.id) {
      analyzeCurrentVideo(sender.tab.id);
      sendResponse({success: true});
    } 
    // Querying for the active tab for video element detection
    else {
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs.length > 0) {
          analyzeCurrentVideo(tabs[0].id);
          sendResponse({success: true});
        } else {
          sendResponse({success: false, error: "No active tab found"});
        }
      });
    }
    return true; // Keeping the message channel open for async response
  }
  
  // Handling history related messages
  if (msg.action === "getHistory") {
    loadAnalysisHistoryFromStorage(() => {
      sendResponse({history: analysisHistory});
    });
    return true;
  }
  else if (msg.action === "clearHistory") {
    analysisHistory = [];
    chrome.storage.local.set({analysisHistory: []});
    sendResponse({success: true, message: "History cleared"});
    return true;
  }
  
  // Handle analyze by URL
  if (msg.action === "analyzeUrl") {
    if (!msg.videoUrl) {
      sendResponse({ success: false, error: "No URL provided" });
      return true;
    }
    
    // Open a new tab in the background to analyze the video
    chrome.tabs.create({ url: msg.videoUrl, active: true }, function(tab) {
      if (!tab || !tab.id) {
        sendResponse({ success: false, error: "Failed to open tab" });
        return;
      }
      
      sendResponse({ success: true });
      
      // Listen for when the tab finishes loading
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          
          // Wait a few seconds to let the video player initialize and potentially start playing
          setTimeout(() => {
            analyzeCurrentVideo(tab.id);
          }, 4000);
        }
      });
    });
    return true;
  }

  // Handling ONNX progress updates from offscreen document
  if (msg.target === 'background' && msg.action === 'updateProgress') {
    if (msg.tabId) {
      sendMessageToTab(msg.tabId, {
        action: "showProgress",
        current: msg.current,
        total: msg.total,
        message: msg.message
      }).catch(() => {});
    }
    return true;
  }
});

async function ensureOffscreenDocumentForUpload() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Running ONNX Runtime Web for uploaded video analysis'
  });
}

function analyzeUploadedFrames(frames, fileName) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return Promise.reject(new Error('No video frames were extracted.'));
  }

  return ensureOffscreenDocumentForUpload().then(() => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'analyzeFrames',
      frames,
      metadata: {
        tabId: null,
        id: `upload-${Date.now()}`,
        timestamp: Date.now(),
        frameCount: frames.length,
        source: 'upload',
        fileName
      }
    }, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!result || result.error) {
        reject(new Error(result?.error || 'The local model returned no result.'));
      } else {
        const requestId = `upload-${Date.now()}`;
        const timestamp = new Date().toISOString();
        const historyResult = {
          ...result,
          requestId,
          timestamp
        };
        analysisHistory.unshift({
          id: requestId,
          date: timestamp,
          url: '',
          platform: 'upload',
          result: historyResult
        });
        analysisHistory = analysisHistory.slice(0, 50);
        chrome.storage.local.set({analysisHistory});
        resolve(result);
      }
    });
  }));
}

// Analyzing current video playing on web page
function analyzeCurrentVideo(tabId) {
  console.log(`Analyzing video in tab ${tabId}`);
  

  if (!tabId) {
    console.error("No valid tab ID for video analysis");
    return;
  }
  
  // Showing initial notification with better error handling
  sendMessageToTab(tabId, { 
    action: "showNotification", 
    type: "start", 
    message: "Capturing video frames for analysis..." 
  }).catch(error => {
    console.warn("Could not send initial notification, continuing anyway");
  }).finally(() => {
    
    
    // Injecting  the capture script with proper error handling
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content-capture.js'],
    })
    .then(() => {
      return chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => {
          // Calling the injected function
          return window.captureVideoWithFallbacks?.() || { 
            error: "Capture function not available", 
            frames: [] 
          };
        }
      });
    })
    .then(results => {
      if (!results || !results[0] || !results[0].result) {
        console.error("No capture results received");
        notifyUser(tabId, "error", "Failed to capture video frames");
        return;
      }
      
      const captureData = results[0].result;
      
      if (captureData.error && (!captureData.frames || captureData.frames.length === 0)) {
        console.error("Capture error:", captureData.error);
        notifyUser(tabId, "error", `Failed to capture video: ${captureData.error}`);
        return;
      }
      
      if (!captureData.frames || captureData.frames.length === 0) {
        console.error("No frames captured");
        notifyUser(tabId, "error", "No video frames could be captured for analysis");
        return;
      }
      
      // Processing successful frame capture results
      processVideoFrames(tabId, captureData);
    })
    .catch(error => {
      console.error("Script execution error:", error);
      notifyUser(tabId, "error", `Capture failed: ${error.message || "Unknown error"}`);
    });
  });
}

// Helper function to process video frames after successful capture
function processVideoFrames(tabId, captureData) {
  // Getting tab URL for storing in history
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) {
      console.error("Error getting tab info:", chrome.runtime.lastError);
      notifyUser(tabId, "error", "Failed to get video information");
      return;
    }
    
    const videoDetails = {
      width: captureData.width,
      height: captureData.height,
      timestamp: Date.now(),
      randomId: Math.random().toString(36).substring(2, 15),
      url: tab.url,
      platform: detectPlatformFromUrl(tab.url),
      frameRate: captureData.frameRate || 30,
      duration: captureData.duration || 0,
      capturePositions: captureData.capturePositions || [],
      frameCount: captureData.frames.length,
      method: captureData.method || "standard"
    };
    
    // Creating appropriate message based on the capture method used 
    let frameCountMessage;
    if (captureData.method === "webrtc") {
      frameCountMessage = `Captured ${captureData.frames.length} frames using screen capture (WebRTC fallback mode)`;
    } else if (captureData.isFallback) {
      frameCountMessage = `Sending ${captureData.frames.length} frames from current position (fallback mode)`;
    } else {
      frameCountMessage = `Sending ${captureData.frames.length} diverse frames from throughout the ${videoDetails.duration.toFixed(1)}s video`;
    }
    
    console.log(frameCountMessage);
    notifyUser(tabId, "progress", frameCountMessage);
    
    // Sending the frames to the API for analysis
    analyzeFrames(tabId, captureData.frames, videoDetails);
  });
}

// Function for sending frames to API for analysis 
function analyzeFrames(tabId, frames, metadata) {

  const requestId = metadata.randomId;
  

  const startTime = performance.now();
  
  // Showing a notification about frame count
  notifyUser(tabId, "progress", `Processing ${frames.length} video frames...`);
  
  // Checking if we have enough frames for a good analysis
  if (frames.length < 10) {
    console.warn(`Only ${frames.length} frames captured - analysis may be less accurate`);
    notifyUser(tabId, "progress", `Note: Limited frames (${frames.length}) may affect accuracy`);
  } else {
    console.log(`Good frame count: ${frames.length} frames for analysis`);
  }
  
  // ===== HYBRID APPROACH: THRESHOLD-BASED BATCH PROCESSING =====
  // Configuringbatch processing parameters
  const BATCH_THRESHOLD = 100; // Only using batches for videos with more than this many frames
  const MAX_FRAMES_PER_BATCH = 200; // Maximum frames per batch )
  
  // Deciding whether to use batch processing based on frame count
  const useBatchProcessing = frames.length > BATCH_THRESHOLD;
  
  console.log(`Using ${useBatchProcessing ? 'batch' : 'single-request'} processing mode for ${frames.length} frames`);
  
  // Preparing base metadata for API
  const baseRequestData = {
    id: requestId,
    timestamp: metadata.timestamp,
    dimensions: `${metadata.width}x${metadata.height}`,
    frameCount: frames.length,
    source: metadata.platform || 'unknown',
    version: '1.2', // Tracking extension version for API compatibility
    facial_data: metadata.facialFrameCount !== undefined ? metadata.facialFrameCount : 0
  };
  
  // If not using batch processing, send all frames at once 
  if (!useBatchProcessing) {
    sendFrameBatch(frames, baseRequestData, tabId, 1, 1);
    return;
  }
  
  // Determining optimal batch size, For batch processing mode
  const batchSize = Math.min(MAX_FRAMES_PER_BATCH, Math.ceil(frames.length / 3));
  const numBatches = Math.ceil(frames.length / batchSize);
  
  console.log(`Batch processing: Sending ${frames.length} frames in ${numBatches} batches (batch size: ${batchSize})`);
  
  // Initializing batch tracking
  let currentBatch = 1;
  let processedResults = [];
  
  // Function to send the next batch
  const processNextBatch = () => {
    if (currentBatch > numBatches) {
      // Combining results from batch processing
      combineResults(processedResults, tabId, metadata);
      return;
    }
    
    const start = (currentBatch - 1) * batchSize;
    const end = Math.min(start + batchSize, frames.length);
    const batchFrames = frames.slice(start, end);
    
    notifyUser(tabId, "progress", `Processing batch ${currentBatch}/${numBatches} (${batchFrames.length} frames)...`);
    
    sendFrameBatch(
      batchFrames, 
      {...baseRequestData, batch: currentBatch, totalBatches: numBatches},
      tabId,
      currentBatch,
      numBatches,
      (result) => {
        if (result && !result.error) {
          processedResults.push(result);
        }
        currentBatch++;
        processNextBatch();
      }
    );
  };
  
  // Processing batches
  processNextBatch();
  
// Function to ensure offscreen document exists
  async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Running ONNX Runtime Web for deepfake detection inference on video frames'
    });
  }

  // Function to send a single batch of frames
  function sendFrameBatch(batchFrames, requestData, tabId, batchNum, totalBatches, callback) {
    const fullRequestData = {
      ...requestData,
      tabId: tabId,
      frames: batchFrames
    };
    
    console.log(`Sending ${totalBatches > 1 ? `batch ${batchNum}/${totalBatches} with ` : ''}${batchFrames.length} frames to offscreen document`);
    
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'analyzeFrames',
        frames: batchFrames,
        metadata: fullRequestData
      }, (result) => {
        if (chrome.runtime.lastError) {
          console.error("Offscreen communication error:", chrome.runtime.lastError);
          handleError(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (result && result.error) {
          console.error("Offscreen processing error:", result.error);
          handleError(new Error(result.error));
          return;
        }
        
        console.log(`Offscreen response ${totalBatches > 1 ? `for batch ${batchNum}/${totalBatches}` : ''}:`, result);
        
        if (totalBatches === 1) {
          const totalTime = Math.round(performance.now() - startTime);
          const validatedResult = {
            deepfake: result.deepfake === true,
            confidence: parseFloat(result.confidence) || 0.5,
            frames_analyzed: parseInt(result.frames_analyzed) || batchFrames.length,
            deepfake_frames: parseInt(result.deepfake_frames) || 0,
            timestamp: requestData.timestamp,
            requestId: requestData.id,
            framesSent: batchFrames.length,
            frameTimes: metadata?.capturePositions || [],
            processingTime: totalTime,
            clientProcessingTime: totalTime,
            apiResponseTime: result.processing_time_ms || 0
          };
          
          if (validatedResult.frames_analyzed === 0) {
            handleError(new Error("The local model didn't analyze any frames. Please try again."));
            return;
          }
          
          showAnalysisResult(tabId, validatedResult, metadata);
        } else {
          if (callback) callback(result);
        }
      });
    }).catch(error => {
      handleError(error);
    });

    function handleError(error) {
      console.error(`Local analysis failed ${totalBatches > 1 ? `for batch ${batchNum}/${totalBatches}` : ''}:`, error);
      let errorMessage = "Analysis failed: " + (error.message || "Unknown error");
      if (totalBatches === 1 || batchNum === 1) {
        notifyUser(tabId, "error", errorMessage);
      }
      if (callback) callback({ error: errorMessage });
    }
  }

  
  // Function to combine results from multiple batches
  function combineResults(results, tabId, metadata) {
    console.log(`Combining results from ${results.length} batches`);
    
    // Handling the case where we have no valid results
    if (results.length === 0) {
      notifyUser(tabId, "error", "Analysis failed: No valid results received from any batch");
      return;
    }
    
    // Calculating combined metrics
    let totalFramesAnalyzed = 0;
    let totalDeepfakeFrames = 0;
    let totalProbabilitySum = 0;
    
    // Processing each batch result
    results.forEach(result => {
      const framesAnalyzed = parseInt(result.frames_analyzed) || 0;
      const deepfakeFrames = parseInt(result.deepfake_frames) || 0;
      const averageProbability = parseFloat(result.avg_prediction);
      
      totalFramesAnalyzed += framesAnalyzed;
      totalDeepfakeFrames += deepfakeFrames;
      totalProbabilitySum += (Number.isFinite(averageProbability)
        ? averageProbability
        : 0.5) * framesAnalyzed;
    });
    
    const averageProbability = totalFramesAnalyzed > 0
      ? totalProbabilitySum / totalFramesAnalyzed
      : 0.5;
    const finalDeepfakeStatus = averageProbability > 0.5;
    const confidence = Math.min(1, Math.abs(averageProbability - 0.5) * 2);
    
    console.log(`Combined analysis: ${averageProbability.toFixed(4)} average fake probability`);
    
    // Preparing the combined result
    const combinedResult = {
      deepfake: finalDeepfakeStatus,
      confidence: confidence,
      avg_prediction: averageProbability,
      frames_analyzed: totalFramesAnalyzed,
      deepfake_frames: totalDeepfakeFrames,
      timestamp: metadata.timestamp,
      requestId: metadata.randomId,
      framesSent: metadata.frameCount || totalFramesAnalyzed,
      frameTimes: metadata.capturePositions || [],
      batches: results.length
    };
    
    // Showing the combined result to the user 
    showAnalysisResult(tabId, combinedResult, metadata);
  }
}

// Showing the analysis result
function showAnalysisResult(tabId, result, metadata) {
    console.log("Showing analysis result:", result);

    chrome.tabs.sendMessage(tabId, {
      action: "showResult",
      result: result
    }, (response) => {
      if (chrome.runtime.lastError) {
        // First attempt failed — try the robust fallback that handles script injection
        console.warn("showResult delivery failed, retrying via sendMessageToTab:", chrome.runtime.lastError.message);
        sendMessageToTab(tabId, { action: "showResult", result: result })
          .catch(() => {
            // Both attempts failed — at minimum clear the progress bar
            sendMessageToTab(tabId, { action: "showNotification", type: "error", message: "Analysis complete but result display failed. Please try again." })
              .catch(() => {});
          });
      }
    });
    
    // Saving the results to history tab for the user to view
    const historyEntry = {
      id: result.requestId,
      date: new Date().toISOString(),
      url: metadata.url,
      platform: metadata.platform || detectPlatformFromUrl(metadata.url),
      result: result
    };
    
    // Adding to history tab
    analysisHistory.unshift(historyEntry);
    if (analysisHistory.length > 50) {
      analysisHistory = analysisHistory.slice(0, 50);
    }
    
    // Saving to browserstorage
    chrome.storage.local.set({analysisHistory: analysisHistory});
}

// Helper function to detect platform from URL
function detectPlatformFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      return 'youtube';
    } else if (hostname.includes('facebook.com') || hostname.includes('fb.com')) {
      return 'facebook';
    } else if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
      return 'twitter';
    } else if (hostname.includes('instagram.com') || hostname.includes('ig.com')) {
      return 'instagram';
    } else if (hostname.includes('tiktok.com')) {
      return 'tiktok';
    } else if (hostname.includes('threads.net')) {
      return 'threads';
    } else {
      return 'generic';
    }
  } catch (_) {
    return 'generic';
  }
}

console.log("VeriGuard background script loaded");