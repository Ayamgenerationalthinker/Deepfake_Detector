// VeriGuard content script
// Tracking active notifications
let activeNotification = null;
let resultOverlay = null;

let progressWidget = null;

function removeProgressBar() {
  // Clear the auto-removal safety timer if the overlay arrived in time
  if (progressAutoRemoveTimer) {
    clearTimeout(progressAutoRemoveTimer);
    progressAutoRemoveTimer = null;
  }
  if (progressWidget && progressWidget.parentNode) {
    progressWidget.remove();
  }
  progressWidget = null;
}

// Tracks auto-removal timer so we only set it once
let progressAutoRemoveTimer = null;

function showProgressBar(current, total, message) {
  const percent = (total && total > 0) ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const statusText = message || (total ? `Processing frame ${current} of ${total}...` : 'Analyzing video frames...');

  if (!progressWidget || !document.body.contains(progressWidget)) {
    progressWidget = document.createElement('div');
    progressWidget.id = 'deepfake-detector-progress-widget';
    progressWidget.className = 'df-progress-card';
    progressWidget.innerHTML = `
      <div class="df-progress-header">
        <div class="df-progress-title">
          <span class="df-spinner"></span>
          <span>VeriGuard Analysis</span>
        </div>
        <span class="df-progress-percent">${percent}%</span>
      </div>
      <div class="df-progress-bar-track">
        <div class="df-progress-bar-fill" style="width: ${percent}%"></div>
      </div>
      <div class="df-progress-status">${statusText}</div>
    `;
    document.body.appendChild(progressWidget);
  } else {
    const percentEl = progressWidget.querySelector('.df-progress-percent');
    const fillEl = progressWidget.querySelector('.df-progress-bar-fill');
    const statusEl = progressWidget.querySelector('.df-progress-status');
    const spinnerEl = progressWidget.querySelector('.df-spinner');

    if (percentEl) percentEl.textContent = `${percent}%`;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (statusEl) statusEl.textContent = statusText;

    // At 100%: stop the spinner and schedule auto-removal as a safety net
    // in case the showResult message is never delivered
    if (percent >= 100) {
      if (spinnerEl) spinnerEl.style.animation = 'none';
      if (!progressAutoRemoveTimer) {
        progressAutoRemoveTimer = setTimeout(() => {
          removeProgressBar();
          progressAutoRemoveTimer = null;
        }, 3000); // remove after 3s if overlay hasn't replaced it
      }
    }
  }
}

// Listening for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Content script received message:", request);
  
  if (request.action === "showNotification") {
    if (request.type === "start" || request.type === "progress") {
      showProgressBar(request.current || 0, request.total || 0, request.message);
    } else {
      showNotification(request.type, request.message);
    }
    sendResponse({success: true});
    return true;
  }
  else if (request.action === "showProgress") {
    showProgressBar(request.current, request.total, request.message);
    sendResponse({success: true});
    return true;
  }
  else if (request.action === "showResult") {
    removeProgressBar();
    showResultOverlay(request.result);
    sendResponse({success: true});
    return true;
  }
  else if (request.action === "analyzeCurrentVideo") {
    // Forwarding the request to the background script with current URL
    chrome.runtime.sendMessage({
      action: "analyzeCurrentVideo",
      url: window.location.href
    });
    sendResponse({success: true});
    return true;
  }
});

function showNotification(type, message) {
  console.log(`Showing notification: ${type} - ${message}`);
  
  if (type === "error") {
    removeProgressBar();
  }
  
  // Removing existing notification if any, in order to show new notifications
  if (activeNotification) {
    activeNotification.remove();
    activeNotification = null;
  }
  
  // Creating notification element
  const notification = document.createElement('div');
  notification.className = 'deepfake-detector-notification';
  
  // Adding appropriate class based on type
  if (type === "error") {
    notification.classList.add('error');
  } else if (type === "progress") {
    notification.classList.add('progress');
  } else if (type === "start") {
    notification.classList.add('start');
  } else if (type === "info") {
    notification.classList.add('info');
  }
  
  // Creating content
  const icon = document.createElement('div');
  icon.className = 'notification-icon';
  
  // Setting icon based on type of notification
  if (type === "error") {
    icon.innerHTML = '⚠️';
  } else if (type === "progress") {
    icon.innerHTML = '⏳';
  } else if (type === "start") {
    icon.innerHTML = '🔍';
  } else if (type === "info") {
    icon.innerHTML = 'ℹ️';
  }
  
  const content = document.createElement('div');
  content.className = 'notification-content';
  content.textContent = message;
  
  // Adding a close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'notification-close';
  closeBtn.innerHTML = '×';
  closeBtn.addEventListener('click', () => {
    notification.remove();
    activeNotification = null;
  });
  
  // Assembling the notification
  notification.appendChild(icon);
  notification.appendChild(content);
  notification.appendChild(closeBtn);
  
  // Adding to page
  document.body.appendChild(notification);
  activeNotification = notification;
  
  // Auto-hide the notification after some delay 
  if (type !== "error") {
    setTimeout(() => {
      if (notification && notification.parentNode) {
        notification.classList.add('hiding');
        setTimeout(() => {
          if (notification && notification.parentNode) {
            notification.remove();
            if (activeNotification === notification) {
              activeNotification = null;
            }
          }
        }, 500);
      }
    }, 5000);
  }
}


// Showing the detailed result as an overlay menu
function showResultOverlay(result) {
  console.log("Showing result overlay:", result);
  
  // Removing existing overlay menu if any
  if (resultOverlay) {
    resultOverlay.remove();
    resultOverlay = null;
  }
  
  // Handling API error responses
  if (result.error) {
    showNotification("error", `Analysis failed: ${result.error}`);
    return;
  }
  
  const isDeepfake = result.deepfake;
  
  // Creating overlay menu container
  const overlay = document.createElement('div');
  overlay.className = 'deepfake-detector-result';
  
  if (isDeepfake) {
    overlay.classList.add('deepfake');
  } else {
    overlay.classList.add('authentic');
  }
  
  // Creating a header
  const header = document.createElement('div');
  header.className = 'result-header';
  
  const title = document.createElement('h2');
  title.textContent = isDeepfake ? 'DEEPFAKE DETECTED' : 'VIDEO APPEARS AUTHENTIC';
  
  const icon = document.createElement('div');
  icon.className = 'result-icon';
  icon.textContent = isDeepfake ? '⚠️' : '✓';
  
  header.appendChild(icon);
  header.appendChild(title);
  
  // Creating a close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'result-close';
  closeBtn.innerHTML = '×';
  closeBtn.addEventListener('click', () => {
    overlay.remove();
    resultOverlay = null;
  });
  
  header.appendChild(closeBtn);
  
  // Creating content
  const content = document.createElement('div');
  content.className = 'result-content';

  // ========== CONFIDENCE SCORE BAR ==========
  const confidencePercent = Math.round((result.confidence || 0) * 100);
  // Color: green for authentic-confidence, red for deepfake-confidence
  const barColor = isDeepfake
    ? `hsl(${Math.round((1 - result.confidence) * 40)}, 90%, 55%)`   // red → orange
    : `hsl(${Math.round(120 + result.confidence * 20)}, 70%, 50%)`;  // green

  const confidenceSection = document.createElement('div');
  confidenceSection.className = 'df-confidence-section';
  confidenceSection.innerHTML = `
    <div class="df-confidence-label">
      <span>AI Confidence</span>
      <span class="df-confidence-pct">${confidencePercent}%</span>
    </div>
    <div class="df-confidence-track">
      <div class="df-confidence-fill" style="width:${confidencePercent}%; background:${barColor};"></div>
    </div>
    <div class="df-confidence-caption">
      ${confidencePercent >= 80 ? 'High confidence result' : confidencePercent >= 50 ? 'Moderate confidence result' : 'Low confidence — treat with caution'}
    </div>
  `;
  content.appendChild(confidenceSection);
  // ==========================================
  const detailsSection = document.createElement('div');
  detailsSection.className = 'details-section';
  
  // For details on the frames that were  analyzed
  const framesRow = document.createElement('div');
  framesRow.className = 'detail-row';
  
  const framesLabel = document.createElement('div');
  framesLabel.className = 'detail-label';
  framesLabel.textContent = 'Frames Analyzed:';
  
  const framesValue = document.createElement('div');
  framesValue.className = 'detail-value';
  framesValue.textContent = result.frames_analyzed || 0;
  
  framesRow.appendChild(framesLabel);
  framesRow.appendChild(framesValue);
  
  // Adding frames analyzed to details section
  detailsSection.appendChild(framesRow);
  
  // Adding processing time to details section 
  if (result.processingTime) {
    const timeRow = document.createElement('div');
    timeRow.className = 'detail-row';
    
    const timeLabel = document.createElement('div');
    timeLabel.className = 'detail-label';
    timeLabel.textContent = 'Total Processing Time:';
    
    const timeValue = document.createElement('div');
    timeValue.className = 'detail-value';
    timeValue.textContent = result.processingTime > 1000 ? 
      (result.processingTime / 1000).toFixed(1) + 's' : 
      result.processingTime + 'ms';
    
    timeRow.appendChild(timeLabel);
    timeRow.appendChild(timeValue);
    detailsSection.appendChild(timeRow);
  }
  
  // Adding the  API processing time if available 
  if (result.apiResponseTime) {
    const apiTimeRow = document.createElement('div');
    apiTimeRow.className = 'detail-row';
    
    const apiTimeLabel = document.createElement('div');
    apiTimeLabel.className = 'detail-label';
    apiTimeLabel.textContent = 'AI Processing Time:';
    
    const apiTimeValue = document.createElement('div');
    apiTimeValue.className = 'detail-value';
    apiTimeValue.textContent = result.apiResponseTime > 1000 ? 
      (result.apiResponseTime / 1000).toFixed(1) + 's' : 
      result.apiResponseTime + 'ms';
    
    apiTimeRow.appendChild(apiTimeLabel);
    apiTimeRow.appendChild(apiTimeValue);
    detailsSection.appendChild(apiTimeRow);
  }
  
  // Adding  summary/explanation to the overlay menu
  const summary = document.createElement('div');
  summary.className = 'result-summary';
  
  if (isDeepfake) {
    summary.innerHTML = `
      <p>Our AI model detected manipulated content in this video.</p>
      <p>Be cautious about sharing or trusting this content.</p>
    `;
  } else {
    summary.innerHTML = `
      <p>No significant signs of manipulation were detected in this video.</p>
      <p>The content appears to be authentic based on our analysis.</p>
    `;
  }
  
  // Assembling all the  content
  content.appendChild(detailsSection);
  content.appendChild(summary);
  
  // ========== ADDING FEEDBACK SECTION HERE ==========
  // Adding feedback buttons
  const feedbackSection = document.createElement('div');
  feedbackSection.className = 'feedback-section';
  
  const feedbackLabel = document.createElement('div');
  feedbackLabel.textContent = 'Was this analysis correct?';
  feedbackLabel.className = 'feedback-label';
  
  const correctBtn = document.createElement('button');
  correctBtn.textContent = '✓ Yes';
  correctBtn.className = 'feedback-btn correct-btn';
  correctBtn.addEventListener('click', () => provideFeedback(result, true));
  
  const incorrectBtn = document.createElement('button');
  incorrectBtn.textContent = '✗ No';
  incorrectBtn.className = 'feedback-btn incorrect-btn';
  incorrectBtn.addEventListener('click', () => provideFeedback(result, false));

  const notSureBtn = document.createElement('button');
  notSureBtn.textContent = '? Not Sure';
  notSureBtn.className = 'feedback-btn not-sure-btn';
  // wasCorrect=null signals genuine uncertainty — distinct from wasCorrect=false (user confirms wrong)
  notSureBtn.addEventListener('click', () => provideFeedback(result, null, null));
  
  feedbackSection.appendChild(feedbackLabel);
  feedbackSection.appendChild(correctBtn);
  feedbackSection.appendChild(incorrectBtn);
  feedbackSection.appendChild(notSureBtn);
  
  content.appendChild(feedbackSection);
  // ========== ENDING OF FEEDBACK SECTION ==========
  
  // Adding help text, if users want to reach out for assistance
  const helpText = document.createElement('div');
  helpText.className = 'help-text';
  helpText.textContent = 'Analysis by VeriGuard';
  
  // Adding CSS styles for timing section and feedback
  const style = document.createElement('style');
  style.textContent = `
    .df-confidence-section {
      padding: 14px 0 10px;
      margin-bottom: 6px;
    }
    .df-confidence-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #94A3B8;
      margin-bottom: 6px;
      font-weight: 500;
    }
    .df-confidence-pct {
      font-weight: 700;
      font-size: 14px;
      color: #eee;
    }
    .df-confidence-track {
      height: 8px;
      border-radius: 4px;
      background: rgba(255,255,255,0.1);
      overflow: hidden;
      margin-bottom: 6px;
    }
    .df-confidence-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .df-confidence-caption {
      font-size: 11px;
      color: #94A3B8;
      text-align: right;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .detail-label {
      color: #94A3B8;
      font-size: 13px;
    }
    .detail-value {
      font-weight: 500;
      font-size: 13px;
    }
    .timing-section {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(6, 182, 212, 0.35);
    }
    .feedback-section {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid rgba(6, 182, 212, 0.35);
      text-align: center;
    }
    .feedback-label {
      margin-bottom: 10px;
      font-size: 14px;
      color: #E2E8F0;
    }
    .feedback-btn {
      padding: 6px 12px;
      margin: 0 5px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: background-color 0.2s;
    }
    .correct-btn {
      background-color: #4CAF50;
      color: white;
    }
    .incorrect-btn {
      background-color: #f44336;
      color: white;
    }
    .correct-btn:hover {
      background-color: #45a049;
    }
    .incorrect-btn:hover {
      background-color: #d32f2f;
    }
    .not-sure-btn {
    background-color: #757575;
    color: white;
  }
    .not-sure-btn:hover {
    background-color: #616161;
  }
  `;
  document.head.appendChild(style);
  
  // Assembling overlay
  overlay.appendChild(header);
  overlay.appendChild(content);
  overlay.appendChild(helpText);
  
  // Adding to page
  document.body.appendChild(overlay);
  resultOverlay = overlay;
  
  // Making the  overlay menu draggable
  makeDraggable(overlay, header);
  
  // Adding keyboard shortcut to close 
  const handleEscKey = (e) => {
    if (e.key === 'Escape' && resultOverlay) {
      resultOverlay.remove();
      resultOverlay = null;
      document.removeEventListener('keydown', handleEscKey);
    }
  };
  
  document.addEventListener('keydown', handleEscKey);
  
  // Logging the timing info to console for debugging
  console.log("Result timing info:", {
    processingTime: result.processingTime,
    apiResponseTime: result.apiResponseTime
  });
}

// provideFeedback function to allow users to give feedback
function provideFeedback(result, wasCorrect, userCorrection) {
  console.log("Providing feedback:", { wasCorrect, userCorrection });
  
  // Creating frameIds array 
  let frameIds = [];
  
  // Trying to get frameIds from result if they exist
  if (result.frameIds) {
    frameIds = result.frameIds;
  } 
  // Extracting frameIds from frames_data if available
  else if (result.frames_data && Array.isArray(result.frames_data)) {
    // If we have frames_data but no frameIds, we'll need to notify the user
    // that their feedback will be recorded but frames won't be saved for training
    console.log("Warning: No frameIds available for feedback, only feedback will be recorded");
  }
  
  // Preparing the feedback data in a format that matches the backend expectations
  const feedbackData = {
    timestamp: Date.now(),
   
    result: {
      deepfake: result.deepfake,
      confidence: result.confidence
    },
   
    deepfake: result.deepfake,
    confidence: result.confidence,
    wasCorrect: wasCorrect,
    frameIds: frameIds,
    userCorrection: userCorrection, 
    source: window.location.hostname 
  };
  
  console.log("Sending feedback data:", feedbackData);
  
  // Keep feedback local because this extension has no cloud backend.
  chrome.storage.local.get({ feedback: [] }, (stored) => {
    const feedback = Array.isArray(stored.feedback) ? stored.feedback : [];
    feedback.push(feedbackData);
    chrome.storage.local.set({ feedback }, () => {
      let message = "Thank you for your feedback!";
      if (userCorrection !== null) {
        message += " This feedback was saved locally.";
      }
      
      showNotification("info", message);
      

      if (resultOverlay) {
        const feedbackSection = resultOverlay.querySelector('.feedback-section');
        if (feedbackSection) {
          feedbackSection.innerHTML = `<p style="color: #4CAF50; font-weight: 500;">${message}</p>`;
        }
      }
    });
  });
  
}



// Making the overlay menu draggable
function makeDraggable(element, handle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  
  if (handle) {
  
    handle.style.cursor = 'move';
    handle.onmousedown = dragMouseDown;
  } else {
 
    element.onmousedown = dragMouseDown;
  }

  function dragMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
  
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
  
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    // Calculating the new cursor position
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    // Setting the element's new position
    element.style.top = (element.offsetTop - pos2) + "px";
    element.style.left = (element.offsetLeft - pos1) + "px";
    element.style.transform = 'none'; 
  }

  function closeDragElement() {

    document.onmouseup = null;
    document.onmousemove = null;
  }
}

console.log("VeriGuard content script loaded");