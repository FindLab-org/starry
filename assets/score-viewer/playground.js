(() => {
  const widgets = window.musicWidgetsBrowser;
  const stage = document.getElementById("score-stage");
  const statusNode = document.getElementById("viewer-status");
  const scoreUrlNode = document.getElementById("score-url");
  const tempoValueNode = document.getElementById("tempo-value");
  const tempoUp = document.getElementById("tempo-up");
  const tempoDown = document.getElementById("tempo-down");
  const playToggle = document.getElementById("play-toggle");
  const originalToggle = document.getElementById("original-toggle");

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFAULT_SOUNDFONT_URL = "assets/soundfont/";

  const state = {
    liveScore: null,
    player: null,
    audioReady: false,
    scheduledTasks: new Set(),
    tokenElements: new Map(),
    activeTokenIds: new Set(),
    scoreId: 0,
    scheduler: null,
    cursor: null,
    pageFrames: [],
    activePage: null,
    baseTempo: null,
    tempoBpm: null,
    hoverSourcePage: null,
  };

  const NOTEHEAD_TYPES = new Set([
    "noteheads-s0",
    "noteheads-s1",
    "noteheads-s2",
    "noteheads-s1-u",
    "noteheads-s2-u",
    "noteheads-s1-d",
    "noteheads-s2-d",
  ]);

  function tokenType(token) {
    return token?.t || token?.typeId || token?.type;
  }

  function isNoteheadToken(token) {
    return NOTEHEAD_TYPES.has(tokenType(token));
  }

  function setStatus(text) {
    statusNode.textContent = text;
  }

  function parseHashUrl() {
    const raw = window.location.hash.slice(1).trim();
    if (!raw) return "";

    const params = new URLSearchParams(raw);
    const urlParam = params.get("url");
    if (urlParam) return urlParam;

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

  function setPlayingUi(isPlaying) {
    playToggle.textContent = isPlaying ? "⏸" : "⏵";
    playToggle.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  }

  function clearScheduledTasks() {
    for (const id of state.scheduledTasks) window.clearTimeout(id);
    state.scheduledTasks.clear();
  }

  function clearHighlights() {
    state.activeTokenIds.clear();
    document.querySelectorAll(".notePlayOn").forEach(element => element.classList.remove("notePlayOn"));
  }

  function resetPlayer() {
    clearScheduledTasks();
    clearHighlights();

    if (state.player) {
      state.player.pause();
      state.player = null;
    }

    if (widgets?.MidiAudio?.stopAllNotes) widgets.MidiAudio.stopAllNotes();
    state.cursor = null;
    state.scheduler = null;
    setPlayingUi(false);
    playToggle.disabled = true;
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
      if (value === undefined || value === null) continue;
      node.setAttribute(key, String(value));
    }
    return node;
  }

  function createNode(name, attrs = {}) {
    const node = document.createElement(name);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === "class") node.className = value;
      else node.setAttribute(key, String(value));
    }
    return node;
  }

  function validateLiveScore(data) {
    if (data?.format !== "LiveScore" || data?.version !== 1 || !Array.isArray(data?.pages)) {
      throw new Error("Invalid LiveScore data.");
    }
    return data;
  }

  async function loadLiveScoreFromResponse(response) {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return validateLiveScore(await response.json());
  }

  function eventSubtype(type) {
    switch (type) {
      case "program": return "programChange";
      case "note-on": return "noteOn";
      case "note-off": return "noteOff";
      case "control": return "controller";
      case "pitch-bend": return "pitchBend";
      case "aftertouch": return "channelAftertouch";
      default: return type;
    }
  }

  function buildMidiNotation(playback) {
    if (!playback?.events?.length || !widgets?.MusicNotation?.Notation?.parseMidi) return null;

    const trackCount = Math.max(1, ...playback.events.map(event => Number.isFinite(event.track) ? event.track + 1 : 1));
    const tracks = Array.from({ length: trackCount }, () => []);

    for (const event of playback.events) {
      const trackIndex = Number.isFinite(event.track) ? event.track : 0;
      tracks[trackIndex].push({
        ticks: event.tick,
        type: "channel",
        subtype: eventSubtype(event.type),
        ...(Number.isFinite(event.channel) ? { channel: event.channel } : {}),
        ...(Number.isFinite(event.note) ? { noteNumber: event.note } : {}),
        ...(Number.isFinite(event.velocity) ? { velocity: event.velocity } : {}),
        ...(Number.isFinite(event.program) ? { programNumber: event.program } : {}),
        ...(Number.isFinite(event.controller) ? { controllerType: event.controller } : {}),
        ...(Number.isFinite(event.value) ? { value: event.value } : {}),
        ...(event.ids?.length ? { ids: event.ids.map(String) } : {}),
      });
    }

    for (const tempo of playback.tempos || []) {
      tracks[0].push({ ticks: tempo.tick, type: "meta", subtype: "setTempo", microsecondsPerBeat: tempo.tempo });
    }

    for (const track of tracks) {
      track.sort((a, b) => a.ticks - b.ticks || (a.subtype === "noteOff" ? -1 : 0));
      let tick = 0;
      for (const event of track) {
        event.deltaTime = Math.max(event.ticks - tick, 0);
        tick = event.ticks;
      }
      track.push({ deltaTime: Math.max((playback.endTick || tick) - tick, 0), type: "meta", subtype: "endOfTrack" });
    }

    const notation = widgets.MusicNotation.Notation.parseMidi({
      header: { formatType: 1, ticksPerBeat: playback.ticksPerBeat || 480 },
      tracks,
    });
    notation.measures = playback.measures?.map(measure => ({ index: measure.i, startTick: measure.t1, endTick: measure.t2 }));
    return notation;
  }

  function buildTokenMap(liveScore) {
    const tokenMap = new Map();
    const positions = liveScore?.playback?.positions;
    if (positions?.length) {
      for (const position of positions) {
        tokenMap.set(String(position.id), {
          system: position.system,
          measure: position.measure,
          x: position.x,
          endX: position.endX,
        });
      }
      return tokenMap;
    }

    (liveScore?.pages || []).forEach((page, pageIndex) => {
      (page.systems || []).forEach((system, systemIndex) => {
        const systemKey = systemGlobalIndex(liveScore, pageIndex, systemIndex);
        (system.staves || []).forEach(staff => {
          (staff.measures || []).forEach((measure, measureIndex) => {
            const endX = system.bars?.[measureIndex] ?? system.w;
            (measure.tokens || []).forEach(token => {
              if (token.id === undefined || token.id === null) return;
              tokenMap.set(String(token.id), { system: systemKey, measure: measureIndex, x: token.x, endX });
            });
          });
        });
      });
    });
    return tokenMap;
  }

  function buildScheduler(liveScore) {
    const tokenMap = buildTokenMap(liveScore);
    const itemsByTick = new Map();

    for (const event of liveScore?.playback?.events || []) {
      if (event.type !== "note-on" || !event.ids?.length) continue;
      for (const id of event.ids) {
        const position = tokenMap.get(String(id));
        if (!position) continue;
        const items = itemsByTick.get(event.tick) || [];
        items.push({ ...position, tick: event.tick });
        itemsByTick.set(event.tick, items);
      }
    }

    const ticks = Array.from(itemsByTick.keys()).sort((a, b) => a - b);
    const tickTable = [];
    for (let index = 0; index < ticks.length; index += 1) {
      const tick = ticks[index];
      const nextTick = ticks[index + 1] ?? liveScore?.playback?.endTick ?? tick;
      for (const item of itemsByTick.get(tick) || []) {
        tickTable.push({
          system: item.system,
          measure: item.measure,
          x: item.x,
          endX: Number.isFinite(item.endX) ? item.endX : item.x,
          tick,
          endTick: nextTick,
        });
      }
    }

    tickTable.sort((a, b) => a.tick - b.tick || a.system - b.system || a.x - b.x);

    return {
      tickTable,
      lookupTick(position) {
        const rowItems = tickTable.filter(item => item.system === position.system).sort((i1, i2) => i1.x - i2.x);
        let item = rowItems.find(candidate => candidate.x <= position.x && candidate.endX >= position.x);
        if (!item) {
          const firstItem = rowItems[0];
          if (firstItem && position.x < firstItem.endX) item = firstItem;
          else return null;
        }
        if (item.endX === item.x) return item.tick;
        return item.tick + (Math.max(position.x - item.x, 0) * (item.endTick - item.tick)) / (item.endX - item.x);
      },
      lookupPosition(tick) {
        const candidates = tickTable.filter(item => item.tick <= tick && item.endTick >= tick);
        const item = candidates[0] || tickTable.find(item => item.tick >= tick) || tickTable.at(-1);
        if (!item) return null;
        if (item.endTick === item.tick || item.endX === item.x) return { system: item.system, measure: item.measure, x: item.x };
        return {
          system: item.system,
          measure: item.measure,
          x: item.x + ((tick - item.tick) * (item.endX - item.x)) / (item.endTick - item.tick),
        };
      },
    };
  }

  function systemGlobalIndex(liveScore, pageIndex, systemIndex) {
    let offset = 0;
    for (let i = 0; i < pageIndex; i += 1) offset += liveScore.pages[i]?.systems?.length || 0;
    return offset + systemIndex;
  }

  function cursorPage(liveScore, system) {
    let systemOffset = 0;
    for (let pageIndex = 0; pageIndex < liveScore.pages.length; pageIndex += 1) {
      const nextOffset = systemOffset + (liveScore.pages[pageIndex].systems?.length || 0);
      if (system >= systemOffset && system < nextOffset) return pageIndex;
      systemOffset = nextOffset;
    }
    return Math.max(0, liveScore.pages.length - 1);
  }

  function lookupMeasureTick(liveScore, position) {
    for (let pageIndex = 0; pageIndex < liveScore.pages.length; pageIndex += 1) {
      const page = liveScore.pages[pageIndex];
      for (let systemIndex = 0; systemIndex < (page.systems || []).length; systemIndex += 1) {
        if (systemGlobalIndex(liveScore, pageIndex, systemIndex) !== position.system) continue;
        const measure = page.systems[systemIndex].measures?.find(item => item.x1 <= position.x && item.x2 >= position.x);
        if (!measure || !Number.isFinite(measure.t1) || !Number.isFinite(measure.t2) || measure.x2 === measure.x1) return null;
        return measure.t1 + ((position.x - measure.x1) * (measure.t2 - measure.t1)) / (measure.x2 - measure.x1);
      }
    }
    return null;
  }

  function lookupSeek(position) {
    const scheduler = state.scheduler;
    const tick = scheduler?.lookupTick(position);
    if (Number.isFinite(tick)) return { position: scheduler.lookupPosition(tick), tick };

    const rowItems = scheduler?.tickTable.filter(item => item.system === position.system) || [];
    const candidates = rowItems.flatMap(item => [item.x, item.endX]).filter(Number.isFinite);
    if (candidates.length) {
      const x = candidates.reduce((closest, value) => Math.abs(value - position.x) < Math.abs(closest - position.x) ? value : closest);
      const snappedPosition = { ...position, x };
      const snappedTick = scheduler.lookupTick(snappedPosition);
      return Number.isFinite(snappedTick) ? { position: scheduler.lookupPosition(snappedTick), tick: snappedTick } : null;
    }

    const measureTick = lookupMeasureTick(state.liveScore, position);
    return Number.isFinite(measureTick) ? { position, tick: measureTick } : null;
  }

  function imageTransform(page) {
    const source = page.source;
    if (!source?.w || !source?.h) return "";
    const interval = source.interval || 1;
    const matrix = source.matrix || [1, 0, 0, 1, 0, 0];
    return `translate(${page.w / 2} ${page.h / 2}) matrix(${matrix.join(" ")}) scale(${1 / interval}) translate(${-source.w / 2} ${-source.h / 2})`;
  }

  function parseStaffLayout(code, visibleCount) {
    const text = (code || "").trim();
    const conjunctions = [];
    const groups = [];
    const stack = [];
    let staffIndex = 0;
    let sawSeparator = false;
    let sawExplicitStaff = false;

    for (const char of text) {
      if ("{<[".includes(char)) {
        const type = char === "{" ? 1 : char === "<" ? 2 : 3;
        stack.push({ type, start: staffIndex, level: stack.length });
      }
      else if ("}>]".includes(char)) {
        const group = stack.pop();
        if (group) groups.push({ ...group, end: staffIndex });
      }
      else if (",-.".includes(char)) {
        conjunctions[staffIndex] = char === "," ? 0 : char === "." ? 1 : 2;
        staffIndex += 1;
        sawSeparator = true;
      }
      else if (!/\s/.test(char)) {
        if (sawExplicitStaff) staffIndex += 1;
        sawExplicitStaff = true;
      }
    }

    while (stack.length) {
      const group = stack.pop();
      groups.push({ ...group, end: staffIndex });
    }

    const staffCount = Math.max(visibleCount, sawSeparator || sawExplicitStaff ? staffIndex + 1 : visibleCount);
    const staffIndexes = Array.from({ length: staffCount }, (_, index) => index);

    return {
      staffIndexes,
      conjunctions: Array.from({ length: Math.max(0, staffCount - 1) }, (_, index) => conjunctions[index] ?? 2),
      groups,
    };
  }

  function staffLayoutForSystem(system) {
    const parsed = parseStaffLayout(state.liveScore?.staffLayout, system.staves?.length || 0);
    const mask = Number.isFinite(system.staffMask) ? system.staffMask : null;
    const visibleOriginalIndexes = parsed.staffIndexes.filter((_, index) => mask === null || ((mask >> index) & 1));
    const visibleIndexes = visibleOriginalIndexes.length ? visibleOriginalIndexes : parsed.staffIndexes.slice(0, system.staves?.length || 0);
    const originalToVisible = new Map(visibleIndexes.map((originalIndex, visibleIndex) => [originalIndex, visibleIndex]));

    return {
      conjunctions: Array.from({ length: Math.max(0, (system.staves?.length || 0) - 1) }, (_, visibleIndex) => {
        const originalIndex = visibleIndexes[visibleIndex];
        return parsed.conjunctions[originalIndex] ?? 2;
      }),
      groups: parsed.groups
        .map(group => ({
          ...group,
          start: originalToVisible.get(group.start),
          end: originalToVisible.get(group.end),
        }))
        .filter(group => Number.isFinite(group.start) && Number.isFinite(group.end) && group.start < group.end),
    };
  }

  function appendBrace(parent, top, bottom, level) {
    const group = createSvgNode("g", { class: "brace", transform: `translate(${-0.2 - level * 1.2}, ${(top + bottom) / 2})` });
    group.appendChild(createSvgNode("path", {
      transform: `scale(0.0040, ${(-0.004 * (bottom - top)) / 15.1825})`,
      d: "M-208 -1336c0 312 124 616 124 912c0 156 -36 300 -144 416c0 4 -4 4 -4 8s4 4 4 8c108 116 144 260 144 416c0 296 -124 600 -124 912c0 212 52 420 196 576c16 16 40 -8 24 -24c-108 -120 -144 -264 -144 -420c0 -292 116 -588 116 -896c0 -212 -48 -416 -188 -572c140 -156 188 -360 188 -572c0 -308 -116 -604 -116 -896c0 -156 36 -300 144 -420c16 -16 -8 -40 -24 -24c-144 156 -196 364 -196 576z",
    }));
    parent.appendChild(group);
  }

  function appendBracket(parent, top, bottom, level) {
    const x = -1.2 - level * 1.2;
    const group = createSvgNode("g", { class: "bracket" });
    group.appendChild(createSvgNode("rect", { x, y: top, width: 0.45, height: bottom - top }));
    group.appendChild(createSvgNode("path", { transform: `translate(${x}, ${top - 0.21}) scale(0.0040, -0.0040)`, d: "M0 -56v91c0 12 10 21 22 21h43c164 0 281 136 377 272c10 14 32 -1 22 -15c-103 -145 -222 -369 -399 -369h-65z" }));
    group.appendChild(createSvgNode("path", { transform: `translate(${x}, ${bottom + 0.21}) scale(0.0040, -0.0040)`, d: "M0 56h65c177 0 296 -224 399 -369c10 -14 -12 -29 -22 -15c-96 136 -213 272 -377 272h-43c-12 0 -22 9 -22 21v91z" }));
    parent.appendChild(group);
  }

  function appendSquareBracket(parent, top, bottom, level) {
    const x = -0.9 - level * 1.2;
    const group = createSvgNode("g", { class: "square" });
    group.appendChild(createSvgNode("line", { x1: x, x2: x, y1: top, y2: bottom, "stroke-width": 0.1 }));
    group.appendChild(createSvgNode("line", { x1: x, x2: 0, y1: top, y2: top, "stroke-width": 0.1 }));
    group.appendChild(createSvgNode("line", { x1: x, x2: 0, y1: bottom, y2: bottom, "stroke-width": 0.1 }));
    parent.appendChild(group);
  }

  function appendStaffBrackets(parent, system, layout) {
    if ((system.staves?.length || 0) < 2) return;
    const group = createSvgNode("g", { class: "staff-brackets" });

    const firstStaff = system.staves[0];
    const lastStaff = system.staves.at(-1);
    if (firstStaff && lastStaff) {
      group.appendChild(createSvgNode("line", {
        class: "connection",
        x1: 0,
        x2: 0,
        y1: firstStaff.y + firstStaff.staffY - 2,
        y2: lastStaff.y + lastStaff.staffY + 2,
      }));
    }

    for (const bracket of layout.groups || []) {
      const topStaff = system.staves[bracket.start];
      const bottomStaff = system.staves[bracket.end];
      if (!topStaff || !bottomStaff) continue;
      const top = topStaff.y + topStaff.staffY - 2;
      const bottom = bottomStaff.y + bottomStaff.staffY + 2;
      if (bracket.type === 1) appendBrace(group, top, bottom, bracket.level || 0);
      else if (bracket.type === 2) appendBracket(group, top, bottom, bracket.level || 0);
      else if (bracket.type === 3) appendSquareBracket(group, top, bottom, bracket.level || 0);
    }
    if (group.childNodes.length) parent.appendChild(group);
  }

  function isTextToken(token) {
    return token?.type === "Text" || token?.type === "text" || typeof token?.text === "string";
  }

  function appendTextTokens(parent, tokens, offsetX = 0, offsetY = 0) {
    for (const token of tokens || []) {
      if (!isTextToken(token) || !token.text || token.textType === "Chord") continue;
      const group = createSvgNode("g", { class: "token text-token", transform: `translate(${offsetX + (token.x || 0)}, ${offsetY + (token.y || 0)})` });
      const text = createSvgNode("text", {
        class: token.textType || "Other",
        x: 0,
        y: -(token.fontSize || 2.8) / 2,
        "dominant-baseline": "hanging",
        "text-anchor": "middle",
        "font-size": token.fontSize || 2.8,
      });
      text.textContent = token.text;
      const title = createSvgNode("title");
      title.textContent = token.textType || "Text";
      text.appendChild(title);
      group.appendChild(text);
      parent.appendChild(group);
    }
  }

  function renderTokens(parent, staff) {
    for (const measure of staff.measures || []) {
      for (const token of measure.tokens || []) {
        if (!isNoteheadToken(token)) continue;
        const type = tokenType(token);
        const element = createSvgNode("use", {
          href: `#score-token-def-${type}`,
          x: token.x,
          y: staff.staffY + token.y,
        });
        if (token.id !== undefined && token.id !== null) {
          const id = String(token.id);
          element.id = id;
          if (state.activeTokenIds.has(id)) element.classList.add("notePlayOn");
          const elements = state.tokenElements.get(id) || [];
          elements.push(element);
          state.tokenElements.set(id, elements);
        }
        parent.appendChild(element);
      }
    }
  }

  function renderLiveScorePage(liveScore, page, pageIndex) {
    const svg = createSvgNode("svg", { class: "live-score-page", viewBox: `0 0 ${page.w} ${page.h}` });
    const originalMode = originalToggle.getAttribute("aria-pressed") === "true";
    const showSource = originalMode || state.hoverSourcePage === pageIndex;

    if (showSource && page.source?.url) {
      svg.appendChild(createSvgNode("image", {
        href: page.source.url,
        width: page.source.w,
        height: page.source.h,
        transform: imageTransform(page),
        opacity: 1,
        preserveAspectRatio: "none",
      }));
    }

    if (!showSource) appendTextTokens(svg, page.tokens);

    (page.systems || []).forEach((system, systemIndex) => {
      const systemKey = systemGlobalIndex(liveScore, pageIndex, systemIndex);
      const firstStaff = system.staves?.[0];
      const lastStaff = system.staves?.at(-1);
      const staffTop = (firstStaff?.y ?? 0) + (firstStaff?.staffY ?? 0) - 2;
      const staffBottom = (lastStaff?.y ?? 0) + (lastStaff?.staffY ?? 0) + 2;
      const systemGroup = createSvgNode("g", { class: "live-score-system", transform: `translate(${system.x}, ${system.y})` });

      for (const staff of system.staves || []) {
        const staffGroup = createSvgNode("g", { class: "live-score-staff", transform: `translate(0, ${staff.y})` });
        if (!showSource && staff.image?.url) {
          staffGroup.appendChild(createSvgNode("image", {
            class: "background",
            href: staff.image.url,
            x: staff.image.x,
            y: staff.image.y,
            width: staff.image.width,
            height: staff.image.height,
          }));
        }
        if (!showSource) {
          [-2, -1, 0, 1, 2].forEach(line => {
            staffGroup.appendChild(createSvgNode("line", { x1: 0, x2: system.w, y1: staff.staffY + line, y2: staff.staffY + line }));
          });
          for (const line of staff.additionalLines || []) {
            staffGroup.appendChild(createSvgNode("line", { x1: line.left, x2: line.right, y1: staff.staffY + line.n, y2: staff.staffY + line.n }));
          }
        }
        renderTokens(staffGroup, staff);
        systemGroup.appendChild(staffGroup);
      }

      if (!showSource) {
        const layout = staffLayoutForSystem(system);
        for (const [barIndex, x] of (system.bars || []).entries()) {
          for (const [staffIndex, staff] of (system.staves || []).entries()) {
            systemGroup.appendChild(createSvgNode("line", {
              class: "bar",
              x1: x,
              x2: x,
              y1: staff.y + staff.staffY - 2,
              y2: staff.y + staff.staffY + 2,
              "data-bar-index": barIndex,
              "data-staff-index": staffIndex,
            }));
          }
          layout.conjunctions.forEach((conjunction, staffIndex) => {
            const staff1 = system.staves[staffIndex];
            const staff2 = system.staves[staffIndex + 1];
            if (!staff1 || !staff2) return;
            systemGroup.appendChild(createSvgNode("line", {
              class: `bar staff-layout-measure-bar${conjunction === 1 ? " dashed" : ""}${conjunction === 0 ? " blank" : ""}`,
              x1: x,
              x2: x,
              y1: staff1.y + staff1.staffY + 2,
              y2: staff2.y + staff2.staffY - 2,
            }));
          });
        }
        appendStaffBrackets(systemGroup, system, layout);
        appendTextTokens(systemGroup, system.tokens);
      }

      if (state.cursor?.system === systemKey) {
        const bars = Array.isArray(system.bars) ? system.bars.filter(Number.isFinite).slice().sort((a, b) => a - b) : [];
        const measureLeft = [...bars].reverse().find(x => x <= state.cursor.x) ?? 0;
        const measureRight = bars.find(x => x > state.cursor.x) ?? system.w;
        systemGroup.insertBefore(createSvgNode("rect", {
          class: "active-measure",
          x: measureLeft,
          y: staffTop,
          width: Math.max(0, measureRight - measureLeft),
          height: staffBottom - staffTop,
        }), systemGroup.firstChild);
      }

      const hit = createSvgNode("rect", { class: "live-score-system-hit", x: 0, y: staffTop, width: system.w, height: staffBottom - staffTop });
      hit.addEventListener("click", event => {
        const rect = hit.getBoundingClientRect();
        const bbox = hit.getBBox();
        const x = ((event.clientX - rect.left) / rect.width) * bbox.width;
        seekPosition({ system: systemKey, x }).catch(error => setStatus(`Seek failed: ${error.message}`));
      });
      systemGroup.appendChild(hit);
      svg.appendChild(systemGroup);
    });

    return svg;
  }

  function renderScore() {
    stage.innerHTML = "";
    state.tokenElements.clear();
    state.pageFrames = [];

    if (!state.liveScore) {
      const empty = createNode("div", { class: "live-score-empty" });
      empty.textContent = "Waiting for a hash URL.";
      stage.appendChild(empty);
      return;
    }

    const pages = createNode("div", { class: "live-score-pages" });
    state.liveScore.pages.forEach((page, pageIndex) => {
      const frame = createNode("article", { class: "live-score-page-frame" });
      frame.addEventListener("mouseenter", () => {
        if (originalToggle.getAttribute("aria-pressed") === "true" || state.hoverSourcePage === pageIndex) return;
        state.hoverSourcePage = pageIndex;
        renderScore();
      });
      frame.addEventListener("mouseleave", () => {
        if (state.hoverSourcePage !== pageIndex) return;
        state.hoverSourcePage = null;
        renderScore();
      });
      frame.appendChild(renderLiveScorePage(state.liveScore, page, pageIndex));
      pages.appendChild(frame);
      state.pageFrames.push(frame);
    });
    stage.appendChild(pages);
  }

  function updateCursor(tick) {
    state.cursor = state.scheduler?.lookupPosition(tick) || null;
    renderScore();
    if (!state.cursor || !state.liveScore) return;
    const pageIndex = cursorPage(state.liveScore, state.cursor.system);
    if (pageIndex === state.activePage) return;
    state.activePage = pageIndex;
    state.pageFrames[pageIndex]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  function setTokenHighlight(ids, enabled) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const key = String(id);
      if (enabled) state.activeTokenIds.add(key);
      else state.activeTokenIds.delete(key);
      const elements = state.tokenElements.get(key);
      if (!elements) continue;
      elements.forEach(element => element.classList.toggle("notePlayOn", enabled));
    }
  }

  function buildPlayer(notation) {
    const { MidiAudio, MidiPlayer } = widgets;
    return new MidiPlayer(notation, {
      cacheSpan: 200,
      onMidi(data, timestamp) {
        if (!data || data.type !== "channel") return;
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
        if (widgets?.MidiAudio?.stopAllNotes) widgets.MidiAudio.stopAllNotes();
        setPlayingUi(false);
        setStatus("Playback finished.");
        if (state.player) state.player.progressTicks = 0;
        updateCursor(0);
      },
    });
  }

  async function ensureAudio() {
    if (state.audioReady) return;
    await widgets.MidiAudio.loadPlugin({ soundfontUrl: soundfontUrl(), api: "webaudio" });
    state.audioReady = true;
  }

  function updateTempoLabel(liveScore) {
    const tempo = liveScore?.playback?.tempos?.[0]?.tempo;
    if (!Number.isFinite(tempo) || tempo <= 0) {
      state.baseTempo = null;
      state.tempoBpm = null;
      tempoValueNode.textContent = "--";
      tempoUp.disabled = true;
      tempoDown.disabled = true;
      return;
    }
    const bpm = Math.round(60000000 / tempo);
    state.baseTempo = tempo;
    state.tempoBpm = bpm;
    tempoValueNode.textContent = String(bpm);
    tempoUp.disabled = false;
    tempoDown.disabled = false;
  }

  function applyTempo(delta) {
    if (!state.liveScore?.playback || !Number.isFinite(state.tempoBpm)) return;
    const wasPlaying = !!state.player?.isPlaying;
    const progressTicks = state.player?.progressTicks || 0;
    if (wasPlaying) state.player.pause();

    state.tempoBpm = Math.max(10, state.tempoBpm + delta);
    tempoValueNode.textContent = String(state.tempoBpm);
    const tempo = Math.round(60000000 / state.tempoBpm);
    if (state.liveScore.playback.tempos?.length) state.liveScore.playback.tempos[0].tempo = tempo;
    else state.liveScore.playback.tempos = [{ tick: 0, tempo }];

    clearScheduledTasks();
    clearHighlights();
    if (widgets?.MidiAudio?.stopAllNotes) widgets.MidiAudio.stopAllNotes();
    const notation = buildMidiNotation(state.liveScore.playback);
    state.player = notation ? buildPlayer(notation) : null;
    if (state.player) state.player.progressTicks = progressTicks;
    playToggle.disabled = !state.player;
    updateCursor(progressTicks);
    if (wasPlaying) playMidi().catch(error => setStatus(`Playback failed: ${error.message}`));
  }

  async function loadScoreFromHash() {
    const scoreUrl = parseHashUrl();
    state.scoreId += 1;
    const requestId = state.scoreId;
    if (scoreUrlNode) scoreUrlNode.value = scoreUrl;
    resetPlayer();
    stage.innerHTML = "";
    tempoValueNode.textContent = "--";
    tempoUp.disabled = true;
    tempoDown.disabled = true;

    if (!scoreUrl) {
      state.liveScore = null;
      renderScore();
      setStatus("Provide a LiveScore URL in location.hash.");
      return;
    }

    setStatus("Loading LiveScore ...");

    try {
      const response = await fetch(scoreUrl, { credentials: "omit" });
      const liveScore = await loadLiveScoreFromResponse(response);
      if (requestId !== state.scoreId) return;

      state.liveScore = liveScore;
      state.scheduler = buildScheduler(liveScore);
      state.activePage = null;
      updateTempoLabel(liveScore);
      renderScore();

      const notation = buildMidiNotation(liveScore.playback);
      if (notation) state.player = buildPlayer(notation);
      playToggle.disabled = !state.player;
      setStatus(state.player ? "LiveScore loaded." : "LiveScore loaded, but no playback data was found.");
    }
    catch (error) {
      if (requestId !== state.scoreId) return;
      state.liveScore = null;
      playToggle.disabled = true;
      renderScore();
      setStatus(`Failed to load LiveScore: ${error.message}`);
    }
  }

  async function playMidi() {
    if (!state.player || state.player.isPlaying) return;
    setStatus("Preparing audio ...");
    await ensureAudio();
    if (widgets?.MidiAudio?.WebAudio?.needsWarmup?.()) await widgets.MidiAudio.WebAudio.awaitWarmup();

    setStatus("Playing.");
    setPlayingUi(true);
    state.player.play({
      nextFrame: () => new Promise(resolve => requestAnimationFrame(() => {
        updateCursor(state.player?.progressTicks || 0);
        resolve();
      })),
    }).catch(error => {
      clearScheduledTasks();
      clearHighlights();
      if (widgets?.MidiAudio?.stopAllNotes) widgets.MidiAudio.stopAllNotes();
      setPlayingUi(false);
      setStatus(`Playback failed: ${error.message}`);
    });
  }

  async function togglePlayback() {
    if (!state.player) return;

    if (state.player.isPlaying) {
      state.player.pause();
      clearScheduledTasks();
      clearHighlights();
      if (widgets?.MidiAudio?.stopAllNotes) widgets.MidiAudio.stopAllNotes();
      setPlayingUi(false);
      setStatus("Paused.");
      return;
    }

    await playMidi();
  }

  async function seekPosition(position) {
    if (!state.player) return;
    const seek = lookupSeek(position);
    if (!seek) return;
    const wasPlaying = state.player.isPlaying;
    if (wasPlaying) {
      state.player.pause();
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    clearScheduledTasks();
    clearHighlights();
    state.player.progressTicks = seek.tick;
    state.cursor = seek.position;
    renderScore();

    if (wasPlaying) await playMidi();
  }

  tempoUp.addEventListener("click", () => applyTempo(10));
  tempoDown.addEventListener("click", () => applyTempo(-10));

  playToggle.addEventListener("click", () => {
    togglePlayback().catch(error => {
      setPlayingUi(false);
      setStatus(`Playback failed: ${error.message}`);
    });
  });

  originalToggle.addEventListener("click", () => {
    const enabled = originalToggle.getAttribute("aria-pressed") !== "true";
    originalToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    originalToggle.classList.toggle("is-active", enabled);
    originalToggle.textContent = enabled ? "Original" : "Parsed";
    state.hoverSourcePage = null;
    renderScore();
  });

  window.addEventListener("hashchange", () => {
    loadScoreFromHash().catch(error => setStatus(`Failed to load LiveScore: ${error.message}`));
  });

  if (!widgets) {
    playToggle.disabled = true;
    setStatus("music-widgets bundle was not loaded.");
    return;
  }

  renderScore();
  loadScoreFromHash().catch(error => setStatus(`Failed to load LiveScore: ${error.message}`));
})();
