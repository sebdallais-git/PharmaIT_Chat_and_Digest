// PharmaLLM - Client-side application

const chatContainer = document.getElementById("chat-container");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const stackSelect = document.getElementById("stack-select");
const stackStatusEl = document.getElementById("stack-status");
const modelSelect = document.getElementById("model-select");
const fileUpload = document.getElementById("file-upload");
const statusEl = document.getElementById("status");
const knowledgeBtn = document.getElementById("knowledge-btn");
const knowledgeModal = document.getElementById("knowledge-modal");
const closeModal = document.getElementById("close-modal");
const knowledgeStats = document.getElementById("knowledge-stats");
const ingestBtn = document.getElementById("ingest-btn");
const searchBtn = document.getElementById("search-btn");
const searchResults = document.getElementById("search-results");
const webSearchToggle = document.getElementById("web-search-toggle");

// Historique de conversation
let conversationHistory = [];

// Prompt history (arrow up/down to recall past inputs)
const promptHistory = [];
let promptHistoryIndex = -1;
let promptDraft = "";

// Auto-resize du textarea
userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
});

// Keyboard handler: Enter to send, Arrow Up/Down for prompt history
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }

  if (e.key === "ArrowUp" && promptHistory.length > 0) {
    // Only activate on first line (cursor at start or single-line input)
    const cursorAtTop = userInput.selectionStart === 0 || !userInput.value.includes("\n");
    if (!cursorAtTop) return;

    e.preventDefault();
    if (promptHistoryIndex === -1) {
      promptDraft = userInput.value;
      promptHistoryIndex = promptHistory.length - 1;
    } else if (promptHistoryIndex > 0) {
      promptHistoryIndex--;
    }
    userInput.value = promptHistory[promptHistoryIndex];
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
    return;
  }

  if (e.key === "ArrowDown" && promptHistoryIndex !== -1) {
    e.preventDefault();
    if (promptHistoryIndex < promptHistory.length - 1) {
      promptHistoryIndex++;
      userInput.value = promptHistory[promptHistoryIndex];
    } else {
      promptHistoryIndex = -1;
      userInput.value = promptDraft;
    }
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
    return;
  }
});

const thinkingSelect = document.getElementById("thinking-select");
const thinkingLabel = document.getElementById("thinking-label");

// The model's own reasoning, collapsed by default. Deliberately a separate
// component from buildReasoningPanel(), which reports RAG pipeline steps: one
// is what the system did, the other is what the model thought.
function createThinkingPanel() {
  const el = document.createElement("details");
  el.className = "reasoning-panel thinking-panel";
  const summary = document.createElement("summary");
  summary.className = "reasoning-header";
  summary.textContent = "Reasoning";
  const body = document.createElement("div");
  body.className = "reasoning-steps";
  el.append(summary, body);
  return {
    el,
    append(text) {
      body.textContent += text;
    },
  };
}

sendBtn.addEventListener("click", sendMessage);

// Load models from the active LLM stack
async function loadModels() {
  try {
    const res = await fetch("/api/chat/models");
    const data = await res.json();
    const stackLabel = (data.stack || "LLM").toUpperCase();

    if (!res.ok) {
      setStatus(`${stackLabel} stack unavailable - run scripts/switch-stack.sh ${data.stack || ""}`.trim(), "error");
      return;
    }

    // Render only what this stack can honour, so the UI can never offer a level
    // the server would reject.
    const levels = Array.isArray(data.thinkingLevels) ? data.thinkingLevels : [];
    thinkingSelect.replaceChildren();
    for (const level of levels) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      thinkingSelect.append(option);
    }
    thinkingLabel.hidden = levels.length === 0;
    const remembered = localStorage.getItem("thinkingLevel");
    thinkingSelect.value = levels.includes(remembered) ? remembered : levels[0] || "";
    thinkingSelect.addEventListener("change", () => {
      localStorage.setItem("thinkingLevel", thinkingSelect.value);
    });

    // Embedding models can't chat; Ollama also lists the chat model as "<name>:latest"
    const chatModels = (data.models || []).filter(
      (m) => m !== data.embeddingModel && !/embed/i.test(m) && m !== `${data.chatModel}:latest`
    );
    if (data.chatModel && !chatModels.includes(data.chatModel)) {
      chatModels.unshift(data.chatModel);
    }

    if (chatModels.length > 0) {
      const sorted = [...chatModels].sort((a, b) =>
        a === data.chatModel ? -1 : b === data.chatModel ? 1 : 0
      );
      modelSelect.innerHTML = sorted
        .map((m) => `<option value="${m}"${m === data.chatModel ? " selected" : ""}>${m}</option>`)
        .join("");
      setStatus(`${stackLabel} stack connected`, "success");
    } else {
      setStatus(`No chat models found on ${stackLabel}`, "error");
    }
  } catch {
    setStatus("LLM stack unavailable - run scripts/switch-stack.sh", "error");
  }
}

// Copier du texte dans le presse-papiers (avec fallback)
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {}
  document.body.removeChild(textarea);
  return Promise.resolve();
}

// Ajouter un message dans le chat
function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `<div class="message-wrapper"><div class="message-content">${formatMessage(content)}</div><button class="copy-btn" title="Copy to clipboard">Copy</button></div>`;
  const copyBtn = div.querySelector(".copy-btn");
  copyBtn.addEventListener("click", () => {
    const text = div.querySelector(".message-content").innerText;
    copyToClipboard(text).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
  });
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

// Formater le texte (markdown basique)
function formatMessage(text) {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

// Build a reasoning panel that shows thought-process steps (safe DOM methods)
function buildReasoningPanel() {
  const el = document.createElement("div");
  el.className = "reasoning-panel";

  // Header
  const header = document.createElement("div");
  header.className = "reasoning-header";

  const icon = document.createElement("span");
  icon.className = "reasoning-icon";
  icon.textContent = "\u25CB"; // circle icon

  const title = document.createElement("span");
  title.className = "reasoning-title";
  title.textContent = "Thinking\u2026";

  const toggle = document.createElement("span");
  toggle.className = "reasoning-toggle";

  header.appendChild(icon);
  header.appendChild(title);
  header.appendChild(toggle);

  // Steps container
  const steps = document.createElement("div");
  steps.className = "reasoning-steps";

  el.appendChild(header);
  el.appendChild(steps);

  // Toggle collapse on click
  header.addEventListener("click", () => {
    el.classList.toggle("collapsed");
  });

  return {
    el,
    addStep(text, sources) {
      const step = document.createElement("div");
      step.className = "reasoning-step";

      const dot = document.createElement("span");
      dot.className = "reasoning-step-dot";

      const label = document.createElement("span");
      label.className = "reasoning-step-text";
      label.textContent = text;

      step.appendChild(dot);
      step.appendChild(label);

      if (sources && sources.length > 0) {
        const sourcesDiv = document.createElement("div");
        sourcesDiv.className = "reasoning-sources";
        sources.forEach((s) => {
          const tag = document.createElement("span");
          tag.className = "reasoning-source-tag";
          tag.textContent = s;
          sourcesDiv.appendChild(tag);
        });
        step.appendChild(sourcesDiv);
      }

      steps.appendChild(step);
    },
    finish(count) {
      title.textContent = "Reasoned over " + count + " steps";
      el.classList.add("done");
      el.classList.add("collapsed");
    },
  };
}

// Afficher l'indicateur de frappe
function showTyping() {
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "typing";
  div.innerHTML = `
    <div class="message-content">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTyping() {
  const typing = document.getElementById("typing");
  if (typing) typing.remove();
}

// Envoyer un message
async function sendMessage() {
  const message = userInput.value.trim();
  if (!message) return;

  // Save to prompt history
  if (promptHistory[promptHistory.length - 1] !== message) {
    promptHistory.push(message);
  }
  promptHistoryIndex = -1;
  promptDraft = "";

  // Afficher le message utilisateur
  addMessage("user", message);
  userInput.value = "";
  userInput.style.height = "auto";

  // Disable send button during processing (textarea stays editable)
  sendBtn.disabled = true;
  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history: conversationHistory,
        model: modelSelect.value,
        webSearch: webSearchToggle.checked,
        ...(thinkingSelect.value ? { thinking: thinkingSelect.value } : {}),
      }),
    });

    removeTyping();

    // Lire le stream SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantContent = "";
    const messageDiv = addMessage("assistant", "");
    const wrapperDiv = messageDiv.querySelector(".message-wrapper");
    const contentDiv = wrapperDiv.querySelector(".message-content");

    // Build reasoning panel (shown during processing, collapses when answer starts)
    const reasoningPanel = buildReasoningPanel();
    let thinkingPanel = null;
    wrapperDiv.insertBefore(reasoningPanel.el, contentDiv);
    let reasoningCount = 0;
    let firstTokenReceived = false;

    let buffer = "";
    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue; // skip malformed chunk, wait for next line
        }
        if (data.error) {
          contentDiv.textContent = data.error;
          contentDiv.style.color = "var(--error)";
          streamDone = true;
          break;
        }
        if (data.truncated) {
          // The answer exists but stops mid-sentence; say so rather than
          // letting it look like the model simply finished there.
          const note = document.createElement("div");
          note.className = "reasoning-step-text";
          note.textContent = "Cut off at the token limit — the answer above is incomplete.";
          wrapperDiv.appendChild(note);
        }
        if (data.thinking) {
          // Model cognition, kept separate from `data.reasoning`, which is RAG
          // pipeline status ("searching knowledge base"). Different things.
          if (!thinkingPanel) {
            thinkingPanel = createThinkingPanel();
            // Above the answer, beside the RAG panel — same container the
            // reasoning panel is inserted into.
            wrapperDiv.insertBefore(thinkingPanel.el, contentDiv);
          }
          thinkingPanel.append(data.thinking);
        }
        if (data.reasoning) {
          reasoningCount++;
          reasoningPanel.addStep(data.reasoning, data.sources || []);
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        if (data.done) {
          if (data.tokenStats && typeof data.tokenStats.tokensPerSecond === "number") {
            const s = data.tokenStats;
            const stackLabel = data.stack ? `${data.stack.toUpperCase()} \u00b7 ` : "";
            const statsDiv = document.createElement("div");
            statsDiv.className = "token-stats";
            statsDiv.textContent = `${stackLabel}TTFT ${((s.ttftMs || 0) / 1000).toFixed(1)}s \u00b7 ${s.tokensPerSecond.toFixed(1)} tok/s \u00b7 ${s.promptTokens || 0} in / ${s.completionTokens || 0} out`;
            wrapperDiv.appendChild(statsDiv);
          }
          if (!firstTokenReceived) {
            reasoningPanel.finish(reasoningCount);
          }
          streamDone = true;
          break;
        }
        if (data.token) {
          // Auto-collapse reasoning on first token
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            reasoningPanel.finish(reasoningCount);
          }
          assistantContent += data.token;
          contentDiv.innerHTML = formatMessage(assistantContent);
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
      }
    }

    // If no reasoning steps were emitted, remove the panel
    if (reasoningCount === 0) {
      reasoningPanel.el.remove();
    }

    // Ajouter a l'historique
    conversationHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: assistantContent }
    );

    // Garder seulement les 20 derniers messages
    if (conversationHistory.length > 15) {
      conversationHistory = conversationHistory.slice(-15);
    }
  } catch (error) {
    removeTyping();
    // This catch wraps the whole request AND the rendering that follows it, so
    // a bug in this file used to surface as "Connection error" and send people
    // to check a stack that was perfectly healthy. Tell the two apart.
    console.error("[chat] request failed:", error);
    const networkFailure =
      error instanceof TypeError && /fetch|network|load failed|failed to fetch/i.test(error.message || "");
    addMessage(
      "assistant",
      networkFailure
        ? "Connection error. Make sure PharmaLLM and its LLM stack are running."
        : `Something went wrong in the page, not the stack: ${error.message}. See the browser console.`,
    );
  } finally {
    sendBtn.disabled = false;
  }
}

// Upload de fichier
fileUpload.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  setStatus(`Uploading ${file.name}...`);

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/knowledge/upload", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();

    if (res.ok) {
      setStatus(`${file.name} ingested (${data.added} chunks)`, "success");
    } else {
      setStatus(data.error, "error");
    }
  } catch {
    setStatus("Upload error", "error");
  }

  fileUpload.value = "";
});

// Modal base de connaissances
knowledgeBtn.addEventListener("click", async () => {
  knowledgeModal.hidden = false;
  await loadKnowledgeStats();
});

closeModal.addEventListener("click", () => {
  knowledgeModal.hidden = true;
});

knowledgeModal.addEventListener("click", (e) => {
  if (e.target === knowledgeModal) knowledgeModal.hidden = true;
});

async function loadKnowledgeStats() {
  try {
    const res = await fetch("/api/knowledge/stats");
    const stats = await res.json();
    knowledgeStats.innerHTML = `
      <p><strong>${stats.totalChunks}</strong> indexed chunks</p>
      <p><strong>Sources:</strong> ${stats.sources.length > 0 ? stats.sources.join(", ") : "None"}</p>
    `;
  } catch {
    knowledgeStats.innerHTML = "<p>Loading error</p>";
  }
}

// Ingerer du texte
ingestBtn.addEventListener("click", async () => {
  const source = document.getElementById("text-source").value.trim();
  const content = document.getElementById("text-content").value.trim();

  if (!source || !content) {
    alert("Please fill in both the source name and text.");
    return;
  }

  try {
    const res = await fetch("/api/knowledge/ingest-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: content, source }),
    });
    const data = await res.json();
    alert(data.message);
    document.getElementById("text-source").value = "";
    document.getElementById("text-content").value = "";
    await loadKnowledgeStats();
  } catch {
    alert("Ingestion error");
  }
});

// Recherche dans la base
searchBtn.addEventListener("click", async () => {
  const query = document.getElementById("search-query").value.trim();
  if (!query) return;

  try {
    const res = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();

    if (data.results.length === 0) {
      searchResults.innerHTML = "<p>No results</p>";
    } else {
      searchResults.innerHTML = data.results
        .map(
          (r) => `
          <div class="search-result">
            <div class="search-result-source">${r.source}</div>
            <div class="search-result-content">${r.content}</div>
          </div>
        `
        )
        .join("");
    }
  } catch {
    searchResults.innerHTML = "<p>Search error</p>";
  }
});

// News Agent modal
const agentBtn = document.getElementById("agent-btn");
const agentModal = document.getElementById("agent-modal");
const closeAgentModal = document.getElementById("close-agent-modal");
const agentStatusEl = document.getElementById("agent-status");
const agentTopicsEl = document.getElementById("agent-topics");
const runAgentBtn = document.getElementById("run-agent-btn");

agentBtn.addEventListener("click", async () => {
  agentModal.hidden = false;
  await loadAgentStatus();
});

closeAgentModal.addEventListener("click", () => {
  agentModal.hidden = true;
});

agentModal.addEventListener("click", (e) => {
  if (e.target === agentModal) agentModal.hidden = true;
});

async function loadAgentStatus() {
  try {
    const res = await fetch("/api/agent/status");
    const data = await res.json();

    let statusHtml = "";
    if (data.isRunning) {
      statusHtml = `<p class="agent-running">Agent is currently running...</p>`;
    } else if (data.lastRun) {
      const date = new Date(data.lastRun.timestamp).toLocaleString();
      statusHtml = `
        <p><strong>Last run:</strong> ${date}</p>
        <p><strong>Articles found:</strong> ${data.lastRun.newArticles}</p>
        <p><strong>Topics checked:</strong> ${data.lastRun.topics}</p>
      `;
    } else {
      statusHtml = `<p>Agent has not run yet in this session.</p>`;
    }
    agentStatusEl.innerHTML = statusHtml;

    if (data.topics) {
      agentTopicsEl.innerHTML = data.topics
        .map((t) => `<span class="topic-tag">${t}</span>`)
        .join(" ");
    }
  } catch {
    agentStatusEl.innerHTML = "<p>Error loading status</p>";
  }
}

runAgentBtn.addEventListener("click", async () => {
  runAgentBtn.disabled = true;
  runAgentBtn.textContent = "Running...";
  agentStatusEl.innerHTML = `<p class="agent-running">Collecting from feeds and filings... this may take a minute.</p>`;

  try {
    const res = await fetch("/api/agent/run", { method: "POST" });
    const data = await res.json();

    if (res.ok) {
      agentStatusEl.innerHTML = `
        <p class="agent-success">${data.message}</p>
        <p><strong>Last run:</strong> ${new Date(data.timestamp).toLocaleString()}</p>
      `;
    } else {
      agentStatusEl.innerHTML = `<p class="agent-error">${data.error}</p>`;
    }
  } catch {
    agentStatusEl.innerHTML = `<p class="agent-error">Failed to run agent</p>`;
  }

  runAgentBtn.disabled = false;
  runAgentBtn.textContent = "Run Now";
});

// Status helper
function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
  if (type) {
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "status";
    }, 5000);
  }
}

// Voice input via MediaRecorder + whisper.cpp backend
const micBtn = document.getElementById("mic-btn");

// Detect supported audio MIME type (Safari = mp4, Chrome/Firefox = webm)
function getAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "",  // empty string = browser default
  ];
  for (const t of types) {
    try {
      if (t === "" || MediaRecorder.isTypeSupported(t)) return t;
    } catch { /* skip */ }
  }
  return "";
}

const audioMimeType = getAudioMimeType();
const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && audioMimeType !== null);

if (canRecord) {
  micBtn.hidden = false;
  let mediaRecorder = null;
  let audioChunks = [];

  micBtn.addEventListener("click", async () => {
    // Stop recording
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      return;
    }

    // Start recording
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const msg = err.name === "NotAllowedError"
        ? "Mic blocked — allow microphone in Safari settings"
        : err.name === "NotFoundError"
          ? "No microphone found"
          : "Mic error: " + (err.message || err.name);
      setStatus(msg, "error");
      return;
    }

    try {
      audioChunks = [];
      const options = audioMimeType ? { mimeType: audioMimeType } : {};
      mediaRecorder = new MediaRecorder(stream, options);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstart = () => {
        micBtn.classList.add("listening");
        userInput.placeholder = "Listening... tap mic to stop";
      };

      mediaRecorder.onstop = async () => {
        micBtn.classList.remove("listening");
        userInput.placeholder = "Transcribing...";

        // Stop all mic tracks
        stream.getTracks().forEach((t) => t.stop());

        if (audioChunks.length === 0) {
          userInput.placeholder = "Ask about a vendor, a customer, or what changed this week...";
          return;
        }

        // Determine file extension from MIME type
        const ext = (mediaRecorder.mimeType || "").includes("mp4") ? "mp4"
          : (mediaRecorder.mimeType || "").includes("ogg") ? "ogg"
          : "webm";
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        const formData = new FormData();
        formData.append("audio", blob, "recording." + ext);

        try {
          const res = await fetch("/api/chat/transcribe", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();

          if (data.text) {
            const before = userInput.value.replace(/\s*$/, "");
            userInput.value = before ? before + " " + data.text : data.text;
            userInput.style.height = "auto";
            userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
          } else if (data.error) {
            setStatus("Transcription failed: " + data.error, "error");
          }
        } catch {
          setStatus("Transcription request failed", "error");
        }

        userInput.placeholder = "Ask about a vendor, a customer, or what changed this week...";
        userInput.focus();
      };

      mediaRecorder.onerror = (e) => {
        micBtn.classList.remove("listening");
        stream.getTracks().forEach((t) => t.stop());
        setStatus("Recording error: " + (e.error?.message || "unknown"), "error");
        userInput.placeholder = "Ask about a vendor, a customer, or what changed this week...";
      };

      mediaRecorder.start();
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setStatus("Recording failed: " + (err.message || err.name), "error");
    }
  });
} else {
  // No MediaRecorder support — keep button hidden
  console.log("[Voice] MediaRecorder not available");
}

// Stack switching: the request needs a Telegram confirmation, so the UI waits and then follows the
// switch it asked for, counting down the confirmation window and reverting if it is cancelled or expires unused.
const STACK_LABELS = { ollama: "Ollama", mlx: "MLX", omlx: "oMLX", splash: "Splash" };
let stackPollTimer = null;
let lastKnownActive = null;
let watching = false; // true while this browser is following the switch it asked for
let watchBaselineStartedAt = null; // progress.startedAt the server reported when we asked (null: none)
let lastSeenStartedAt = null; // progress.startedAt from the most recent /api/stack/status
let watchExpiresAt = null; // expires_at from the 202 body of that request
let watchId = null; // id from the 202 body: matches status.cancelled when this request is cancelled
const CONFIRM_GRACE_MS = 15000; // the script writes its first phase within a second of the tap

// Decides whether a progress record is the switch this browser asked for. Both values come from
// the server (startedAt is stamped on the Mac), so the iPad's clock never enters the comparison:
// comparing the Mac's timestamp against the browser's Date.now() made a switch that had actually
// succeeded look foreign whenever the iPad's clock led the Mac's, and the UI reported it expired.
function isOurSwitchProgress(progress, baselineStartedAt) {
  if (!progress) return false;
  return progress.startedAt !== baselineStartedAt;
}

// Same wording as src/services/switch-labels.ts. The browser cannot import TypeScript, so this is a
// deliberate second copy; __tests__/switch-labels.test.ts pins the wording both must produce
function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Same wording as src/services/switch-labels.ts. The browser cannot import TypeScript, so this is a
// deliberate second copy; __tests__/switch-labels.test.ts pins the wording both must produce
function isStackSelectDisabled(status, busy) {
  return busy || Boolean(status.pending) || !status.telegram_configured || !status.hermes_ready;
}

function describeStackStatus(status) {
  if (status.pending) return `Confirm the switch to ${status.pending.target.toUpperCase()} in Telegram`;
  const p = status.progress;
  if (p && p.phase === "failed") return `Switch to ${p.target.toUpperCase()} failed: ${p.error || "unknown error"}`;
  if (p && p.phase === "ready" && p.finishedAt) {
    return `${p.target.toUpperCase()} stack ready (${Math.round((p.finishedAt - p.startedAt) / 1000)} s)`;
  }
  const text = { confirmed: "starting", stopping: "stopping the current stack", starting: "starting the server",
                 warming: "warming up the model", indexing: "checking the indexes" };
  if (p && text[p.phase]) return `Switching to ${p.target.toUpperCase()}: ${text[p.phase]}`;
  return `${status.active.toUpperCase()} stack active`;
}

// Writes the switch status into its own persistent element (#stack-status), not the transient
// #status toast, which erases itself after 5 seconds and would never show a completed switch.
// Literal copy of stackOptionState in src/services/switch-labels.ts (the browser cannot import
// TypeScript); __tests__/switch-labels.test.ts pins the two together.
function stackOptionState(name, status) {
  const entry = status.availability ? status.availability[name] : undefined;
  if (name === status.active || !entry || entry.available) return { disabled: false, title: null };
  return { disabled: true, title: entry.reason || `${name} cannot start` };
}

function renderStackStatus(status) {
  const options = (status.stacks || ["ollama", "mlx", "omlx", "splash"])
    .map((name) => {
      const selected = (status.pending ? status.pending.target : status.active) === name ? " selected" : "";
      // A stack that cannot start is shown, disabled, with the reason as its tooltip
      const state = stackOptionState(name, status);
      const attrs = state.disabled
        ? ` disabled title="${String(state.title).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`
        : "";
      const label = (STACK_LABELS[name] || name) + (state.disabled ? " (unavailable)" : "");
      return `<option value="${name}"${selected}${attrs}>${label}</option>`;
    })
    .join("");
  if (stackSelect.innerHTML !== options) stackSelect.innerHTML = options;
  stackSelect.title = !status.telegram_configured
    ? "Telegram confirmation not configured - run scripts/switch-stack.sh telegram"
    : !status.hermes_ready
      ? `Hermes cannot receive the Telegram confirmation: ${status.hermes_reason || "unknown reason"}`
      : "LLM stack (deployment environment)";

  // Remembered for the next request: whatever is on the server now is what "not ours yet" means.
  lastSeenStartedAt = status.progress ? status.progress.startedAt : null;

  // A progress entry counts as "ours" once it differs from the one the server had when this browser
  // posted its request; right after the Telegram tap, pending is already cleared but progress here
  // still holds the PREVIOUS switch's terminal state, so following pending alone would stop
  // tracking too early.
  const oursHasAppeared = watching && isOurSwitchProgress(status.progress, watchBaselineStartedAt);
  let label, cls, busy;

  if (watching && !oursHasAppeared && status.cancelled && status.cancelled.id === watchId) {
    watching = false;
    watchExpiresAt = null;
    watchId = null;
    label = "Switch cancelled";
    cls = "";
    busy = false;
    stackSelect.value = status.active;
  } else if (watching && !oursHasAppeared) {
    if (Date.now() < watchExpiresAt + CONFIRM_GRACE_MS) {
      label = `${describeStackStatus(status)} (${formatCountdown(watchExpiresAt - Date.now())} left)`;
      cls = "busy";
      busy = true;
    } else {
      watching = false;
      watchExpiresAt = null;
      watchId = null;
      label = "Switch request expired";
      cls = "error";
      busy = false;
      stackSelect.value = status.active;
    }
  } else if (oursHasAppeared) {
    const phase = status.progress.phase;
    busy = phase !== "ready" && phase !== "failed";
    if (!busy) {
      watching = false;
      watchExpiresAt = null;
      watchId = null;
    }
    label = describeStackStatus(status);
    cls = phase === "ready" ? "ready" : phase === "failed" ? "error" : "busy";
  } else {
    // Not watching: page load, or another browser's switch
    const phase = status.progress && status.progress.phase;
    busy = Boolean(status.pending) || (phase && phase !== "ready" && phase !== "failed");
    label = describeStackStatus(status);
    cls = phase === "failed" ? "error" : phase === "ready" ? "ready" : busy ? "busy" : "";
  }

  // F1: computed from `busy`, not just `status.pending` — `pending` clears the instant the
  // Telegram link is tapped, so a gate keyed on it alone went live again while the switch script
  // was still stopping/starting model servers, letting a second switch be requested mid-run.
  stackSelect.disabled = isStackSelectDisabled(status, busy);

  stackStatusEl.textContent = label;
  stackStatusEl.className = cls ? `stack-status ${cls}` : "stack-status";

  if (status.active !== lastKnownActive) {
    lastKnownActive = status.active;
    loadModels();
  }
  return busy;
}

async function pollStackStatus() {
  try {
    const res = await fetch("/api/stack/status");
    if (!res.ok) return true;
    return renderStackStatus(await res.json());
  } catch {
    // F3 (deliberate deviation from amendment A): written to #stack-status, not setStatus.
    // setStatus erases itself after 5s, but the app can be down for a minute or more while it
    // restarts on the new stack — a toast would vanish long before the app comes back, leaving
    // no indication anything is still happening. Keep polling rather than reporting an error.
    stackStatusEl.textContent = "Switching stack: waiting for PharmaLLM to come back";
    stackStatusEl.className = "stack-status busy";
    return true;
  }
}

function watchStackSwitch() {
  if (stackPollTimer) return;
  stackPollTimer = setInterval(async () => {
    const busy = await pollStackStatus();
    if (!busy) {
      clearInterval(stackPollTimer);
      stackPollTimer = null;
    }
  }, 3000);
}

stackSelect.addEventListener("change", async () => {
  const target = stackSelect.value;
  const previousValue = lastKnownActive;
  stackSelect.disabled = true;
  // Captured before the POST: the server can write the first progress phase before the response
  // resolves, and "ours" is decided by comparing against the progress record that was on the
  // server at this moment, not against any browser-side clock reading.
  watchBaselineStartedAt = lastSeenStartedAt;
  watching = true;
  try {
    const res = await fetch("/api/stack/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: target }),
    });
    const data = await res.json();
    if (!res.ok) {
      watching = false;
      watchExpiresAt = null;
      watchId = null;
      if (previousValue) stackSelect.value = previousValue;
      setStatus(data.error || "Stack switch refused", "error");
      await pollStackStatus();
      return;
    }
    watchExpiresAt = data.expires_at;
    watchId = data.id;
    watchStackSwitch();
    await pollStackStatus();
  } catch {
    watching = false;
    watchExpiresAt = null;
    watchId = null;
    if (previousValue) stackSelect.value = previousValue;
    setStatus("Could not reach PharmaLLM", "error");
  }
});

pollStackStatus().then((busy) => {
  if (busy) watchStackSwitch();
});

// Init
loadModels();
