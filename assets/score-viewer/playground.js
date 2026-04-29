(() => {
  const widgets = window.musicWidgetsBrowser;
  const stage = document.getElementById("score-stage");
  const statusNode = document.getElementById("viewer-status");
  const scoreUrlNode = document.getElementById("score-url");
  const tempoNode = document.getElementById("tempo-label");
  const playToggle = document.getElementById("play-toggle");
  const originalToggle = document.getElementById("original-toggle");

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFAULT_SOUNDFONT_URL = "https://huggingface.co/spaces/k-l-lambda/starry/resolve/main/soundfont/";
  const NOTEHEAD_PREFIX = "noteheads-";

  const state = {
    score: null,
    player: null,
    audioReady: false,
    scheduledTasks: new Set(),
    tokenElements: new Map(),
    scoreId: 0,
  };

  function setStatus(text) {
    statusNode.textContent = text;
  }

  function parseHashUrl() {
    const raw = window.location.hash.slice(1).trim();
    if (!raw)
      return "";

    const params = new URLSearchParams(raw);
    const urlParam = params.get("url");
    if (urlParam)
      return urlParam;

    try {
      return decodeURIComponent(raw);
    }
    catch {
      return raw;
    }
  }

  function soundfontUrl() {
    const query = new URLSearchParams(window.location.search);
    return query.get("soundfont") || DEFAULT_SOUNDFONT_URL;
  }

  function clearScheduledTasks() {
    for (const id of state.scheduledTasks)
      window.clearTimeout(id);
    state.scheduledTasks.clear();
  }

  function setPlayingUi(isPlaying) {
    playToggle.textContent = isPlaying ? "Pause" : "Play";
  }

  function clearHighlights() {
    for (const elements of state.tokenElements.values())
      elements.forEach(element => element.classList.remove("on"));
  }

  function setTokenHighlight(ids, enabled) {
    if (!Array.isArray(ids))
      return;

    for (const id of ids) {
      const elements = state.tokenElements.get(id);
      if (!elements)
        continue;

      elements.forEach(element => element.classList.toggle("on", enabled));
    }
  }

  function scheduleAt(timestamp, task) {
    const delay = Math.max(0, timestamp - performance.now());
    const timeoutId = window.setTimeout(() => {
      state.scheduledTasks.delete(timeoutId);
      task();
    }, delay);
    state.scheduledTasks.add(timeoutId);
  }

  function createSvgNode(name, attrs = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null)
        continue;
      node.setAttribute(key, String(value));
    }
    return node;
  }

  function renderOriginalPage(page) {
    const svg = createSvgNode("svg", {
      viewBox: `0 0 ${page.width} ${page.height}`,
      role: "img",
      "aria-label": "Original score page",
    });

    if (!page.source || !page.source.url)
      return svg;

    const group = createSvgNode("g", {
      transform: `translate(${page.width / 2} ${page.height / 2})`,
    });

    const { source } = page;
    const width = source.dimensions.width / source.interval;
    const height = source.dimensions.height / source.interval;

    const image = createSvgNode("image", {
      href: source.url,
      class: "score-source",
      transform: Array.isArray(source.matrix) ? `matrix(${source.matrix.join(" ")})` : undefined,
      x: -width / 2,
      y: -height / 2,
      width,
      height,
    });

    group.appendChild(image);
    svg.appendChild(group);
    return svg;
  }

  function appendStaffLines(parent, staffY, width) {
    const lines = createSvgNode("g", {
      class: "score-staff-lines",
      transform: `translate(0 ${staffY})`,
    });

    [-2, -1, 0, 1, 2].forEach(y => {
      lines.appendChild(createSvgNode("line", { x1: 0, x2: width, y1: y, y2: y }));
    });

    parent.appendChild(lines);
  }

  function appendMeasureBars(parent, measureBars, staffY) {
    const bars = createSvgNode("g", { class: "score-measure-bars" });
    (measureBars || []).forEach(x => {
      const group = createSvgNode("g", { transform: `translate(${x} ${staffY})` });
      group.appendChild(createSvgNode("line", { x1: 0, x2: 0, y1: -2, y2: 2 }));
      bars.appendChild(group);
    });
    parent.appendChild(bars);
  }

  function renderMeasureTokens(parent, staff) {
    const layer = createSvgNode("g", {
      class: "score-measure-tokens",
      transform: `translate(0 ${staff.staffY})`,
    });

    for (const measure of staff.measures || []) {
      for (const token of measure.tokens || []) {
        if (!token || !token.typeId || !token.typeId.startsWith(NOTEHEAD_PREFIX))
          continue;

        const element = createSvgNode("g", {
          class: "score-notehead",
          transform: `translate(${token.x} ${token.y})`,
          "data-token-id": token.id,
        });
        element.appendChild(createSvgNode("use", { href: `#score-token-def-${token.typeId}` }));
        layer.appendChild(element);

        if (token.id !== undefined && token.id !== null) {
          const elements = state.tokenElements.get(token.id) || [];
          elements.push(element);
          state.tokenElements.set(token.id, elements);
        }
      }
    }

    parent.appendChild(layer);
  }

  function noteheadTypeForEvent(event) {
    const base = event.division <= 0 ? "noteheads-s0" : event.division === 1 ? "noteheads-s1" : "noteheads-s2";
    if (event.division <= 0 || !event.stemDirection)
      return base;

    return `${base}-${event.stemDirection}`;
  }

  function renderSpartitoEvents(parent, systemIndex) {
    const measures = state.score?.spartito?.measures;
    if (!Array.isArray(measures))
      return;

    const layer = createSvgNode("g", { class: "score-spartito-events" });

    for (const measure of measures) {
      if (measure?.position?.systemIndex !== systemIndex)
        continue;

      for (const event of measure.events || []) {
        if (event.rest || !Array.isArray(event.ys))
          continue;

        const staffY = measure.position.staffYs?.[event.staff];
        if (!Number.isFinite(staffY))
          continue;

        const typeId = noteheadTypeForEvent(event);
        for (let index = 0; index < event.ys.length; index += 1) {
          const tokenId = event.noteIds?.[index];
          const element = createSvgNode("g", {
            class: "score-notehead",
            transform: `translate(${event.x} ${staffY + event.ys[index]})`,
            "data-token-id": tokenId,
          });
          element.appendChild(createSvgNode("use", { href: `#score-token-def-${typeId}` }));
          layer.appendChild(element);

          if (tokenId !== undefined && tokenId !== null) {
            const elements = state.tokenElements.get(tokenId) || [];
            elements.push(element);
            state.tokenElements.set(tokenId, elements);
          }
        }
      }
    }

    parent.appendChild(layer);
  }

  function renderSymbolicPage(page, systemOffset) {
    const svg = createSvgNode("svg", {
      viewBox: `0 0 ${page.width} ${page.height}`,
      role: "img",
      "aria-label": "Rendered score page",
    });

    (page.systems || []).forEach((system, pageSystemIndex) => {
      const systemGroup = createSvgNode("g", {
        class: "score-system",
        transform: `translate(${system.left} ${system.top})`,
      });

      for (const staff of system.staves || []) {
        const staffGroup = createSvgNode("g", {
          class: "score-staff",
          transform: `translate(0 ${staff.top})`,
        });
        appendStaffLines(staffGroup, staff.staffY, system.width);
        appendMeasureBars(staffGroup, system.measureBars, staff.staffY);
        renderMeasureTokens(staffGroup, staff);
        systemGroup.appendChild(staffGroup);
      }

      renderSpartitoEvents(systemGroup, systemOffset + pageSystemIndex);

      svg.appendChild(systemGroup);
    });

    return svg;
  }

  function renderScore() {
    stage.innerHTML = "";
    state.tokenElements.clear();

    if (!state.score)
      return;

    const showOriginal = originalToggle.checked;
    let systemOffset = 0;
    for (const page of state.score.pages || []) {
      const pageCard = document.createElement("article");
      pageCard.className = "score-page";
      pageCard.appendChild(showOriginal ? renderOriginalPage(page) : renderSymbolicPage(page, systemOffset));
      stage.appendChild(pageCard);
      systemOffset += page.systems?.length || 0;
    }
  }

  function buildPlayer(notation) {
    const { MidiAudio, MidiPlayer, MusicNotation } = widgets;

    Object.setPrototypeOf(notation, MusicNotation.Notation.prototype);

    return new MidiPlayer(notation, {
      cacheSpan: 200,
      onMidi(data, timestamp) {
        if (!data || data.type !== "channel")
          return;

        switch (data.subtype) {
          case "programChange":
            MidiAudio.programChange(data.channel, data.programNumber);
            break;
          case "noteOn":
            MidiAudio.noteOn(data.channel, data.noteNumber, data.velocity, timestamp);
            scheduleAt(timestamp, () => setTokenHighlight(data.ids, true));
            break;
          case "noteOff":
            MidiAudio.noteOff(data.channel, data.noteNumber, timestamp);
            scheduleAt(timestamp, () => setTokenHighlight(data.ids, false));
            break;
        }
      },
      onPlayFinish() {
        clearScheduledTasks();
        clearHighlights();
        if (widgets?.MidiAudio?.stopAllNotes)
          widgets.MidiAudio.stopAllNotes();
        setPlayingUi(false);
        setStatus("Playback finished.");
        if (state.player)
          state.player.progressTicks = 0;
      },
    });
  }

  async function ensureAudio() {
    if (state.audioReady)
      return;

    const { MidiAudio } = widgets;
    await MidiAudio.loadPlugin({
      soundfontUrl: soundfontUrl(),
      api: "webaudio",
    });
    state.audioReady = true;
  }

  function updateTempoLabel(score) {
    const tempo = score?.performing?.notation?.tempos?.[0]?.tempo;
    if (!Number.isFinite(tempo) || tempo <= 0) {
      tempoNode.textContent = "Tempo: -- bpm";
      return;
    }

    tempoNode.textContent = `Tempo: ${Math.round(60000000 / tempo)} bpm`;
  }

  function resetPlayer() {
    clearScheduledTasks();
    clearHighlights();

    if (state.player) {
      state.player.pause();
      state.player = null;
    }

    if (widgets?.MidiAudio?.stopAllNotes)
      widgets.MidiAudio.stopAllNotes();

    setPlayingUi(false);
    playToggle.disabled = !state.score?.performing?.notation;
  }

  async function loadScoreFromHash() {
    const scoreUrl = parseHashUrl();
    state.scoreId += 1;
    const requestId = state.scoreId;
    scoreUrlNode.value = scoreUrl;
    resetPlayer();
    stage.innerHTML = "";
    tempoNode.textContent = "Tempo: -- bpm";

    if (!scoreUrl) {
      state.score = null;
      setStatus("Provide a score.json URL in location.hash.");
      return;
    }

    setStatus("Loading score.json ...");

    try {
      const response = await fetch(scoreUrl, { credentials: "omit" });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}`);

      const score = await response.json();
      if (requestId !== state.scoreId)
        return;

      state.score = score;
      renderScore();
      updateTempoLabel(score);

      if (score?.performing?.notation)
        state.player = buildPlayer(score.performing.notation);

      playToggle.disabled = !state.player;
      setStatus(state.player ? "Score loaded." : "Score loaded, but no performing notation was found.");
    }
    catch (error) {
      if (requestId !== state.scoreId)
        return;

      state.score = null;
      playToggle.disabled = true;
      setStatus(`Failed to load score.json: ${error.message}`);
    }
  }

  async function togglePlayback() {
    if (!state.player)
      return;

    if (state.player.isPlaying) {
      state.player.pause();
      clearScheduledTasks();
      clearHighlights();
      if (widgets?.MidiAudio?.stopAllNotes)
        widgets.MidiAudio.stopAllNotes();
      setPlayingUi(false);
      setStatus("Paused.");
      return;
    }

    setStatus("Preparing audio ...");
    await ensureAudio();

    if (widgets?.MidiAudio?.WebAudio?.needsWarmup?.())
      await widgets.MidiAudio.WebAudio.awaitWarmup();

    setStatus("Playing.");
    setPlayingUi(true);

    state.player.play().catch(error => {
      clearScheduledTasks();
      clearHighlights();
      if (widgets?.MidiAudio?.stopAllNotes)
        widgets.MidiAudio.stopAllNotes();
      setPlayingUi(false);
      setStatus(`Playback failed: ${error.message}`);
    });
  }

  playToggle.addEventListener("click", () => {
    togglePlayback().catch(error => {
      setPlayingUi(false);
      setStatus(`Playback failed: ${error.message}`);
    });
  });

  originalToggle.addEventListener("change", () => {
    renderScore();
  });

  window.addEventListener("hashchange", () => {
    loadScoreFromHash().catch(error => {
      setStatus(`Failed to load score.json: ${error.message}`);
    });
  });

  if (!widgets) {
    playToggle.disabled = true;
    setStatus("music-widgets bundle was not loaded.");
    return;
  }

  loadScoreFromHash().catch(error => {
    setStatus(`Failed to load score.json: ${error.message}`);
  });
})();
