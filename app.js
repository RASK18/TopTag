(function () {
  "use strict";

  var STEAM_ID_BASE = 76561197960265728n;
  var CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  var MAX_FAMILY_PROFILES = 5;
  var STORE_CONCURRENCY = 10;
  var TAG_CONCURRENCY = 5;
  var TAG_BATCH_SIZE = 50;
  var SKIPPED_REASONS = {
    duplicateFamily: "Ya estaba en la biblioteca principal o repetido en familia.",
    freeFamily: "Juego gratuito familiar: no cuenta para Family Sharing.",
    notShareableFamily: "No es un juego compartible por Family Sharing.",
    unknownEligibility: "No se pudo validar Family Sharing en Steam Store.",
    noTags: "Steam no devolvio tags para este juego.",
    failedTags: "No se pudieron cargar los tags de Steam.",
    extraProfiles: "Perfil familiar fuera del limite de 5."
  };

  var elements = {
    form: document.getElementById("lookupForm"),
    primaryProfile: document.getElementById("primaryProfile"),
    familyProfilesField: document.getElementById("familyProfilesField"),
    familyProfiles: document.getElementById("familyProfiles"),
    workerEndpoint: document.getElementById("workerEndpoint"),
    includeFamily: document.getElementById("includeFamily"),
    submitButton: document.getElementById("submitButton"),
    shareButton: document.getElementById("shareButton"),
    clearCacheButton: document.getElementById("clearCacheButton"),
    skippedDetailsButton: document.getElementById("skippedDetailsButton"),
    formMessage: document.getElementById("formMessage"),
    statusText: document.getElementById("statusText"),
    progressCount: document.getElementById("progressCount"),
    progressBar: document.getElementById("progressBar"),
    ownedCount: document.getElementById("ownedCount"),
    familyEligibleCount: document.getElementById("familyEligibleCount"),
    tagsLoadedCount: document.getElementById("tagsLoadedCount"),
    skippedCount: document.getElementById("skippedCount"),
    resultMode: document.getElementById("resultMode"),
    tagsTableBody: document.getElementById("tagsTableBody"),
    toastRoot: document.getElementById("toastRoot"),
    playerCard: document.getElementById("playerCard"),
    playerAvatar: document.getElementById("playerAvatar"),
    playerName: document.getElementById("playerName"),
    playerSteamId: document.getElementById("playerSteamId"),
    tagModal: document.getElementById("tagModal"),
    tagModalClose: document.getElementById("tagModalClose"),
    tagModalTitle: document.getElementById("tagModalTitle"),
    tagModalMeta: document.getElementById("tagModalMeta"),
    tagModalFirstHeader: document.getElementById("tagModalFirstHeader"),
    tagModalSecondHeader: document.getElementById("tagModalSecondHeader"),
    tagModalGames: document.getElementById("tagModalGames")
  };

  var state = createEmptyState();
  var currentRunId = 0;

  restoreSettings();
  var shouldAutoRunFromUrl = restoreFormFromUrl();
  bindEvents();
  if (shouldAutoRunFromUrl) {
    window.setTimeout(runLookup, 0);
  }

  function bindEvents() {
    elements.form.addEventListener("submit", function (event) {
      event.preventDefault();
      writeFormToUrl();
      runLookup();
    });

    elements.includeFamily.addEventListener("change", function () {
      syncFamilyField();
      writeFormToUrl();
      if (!state.ownedGames.length) {
        return;
      }

      ensureTagsForSelection().catch(function (error) {
        addLog(error.message, "error");
      });
    });

    elements.primaryProfile.addEventListener("input", writeFormToUrl);
    elements.familyProfiles.addEventListener("input", writeFormToUrl);

    elements.shareButton.addEventListener("click", function () {
      copyShareUrl();
    });

    elements.clearCacheButton.addEventListener("click", function () {
      try {
        clearAppCache();
        updateSummary();
        showToast("Cache local limpiada.", "success");
      } catch (error) {
        showToast("No se pudo limpiar la cache.", "error");
      }
    });

    elements.skippedDetailsButton.addEventListener("click", openSkippedModal);
    elements.workerEndpoint.addEventListener("change", saveSettings);
    elements.tagModalClose.addEventListener("click", closeTagModal);
    elements.tagModal.addEventListener("click", function (event) {
      if (event.target === elements.tagModal) {
        closeTagModal();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !elements.tagModal.hidden) {
        closeTagModal();
      }
    });

    syncFamilyField();
  }

  function createEmptyState() {
    return {
      ownedGames: [],
      familyGames: [],
      tagCache: new Map(),
      logs: [],
      skipped: {
        duplicateFamily: 0,
        freeFamily: 0,
        notShareableFamily: 0,
        unknownEligibility: 0,
        noTags: 0,
        failedTags: 0,
        extraProfiles: 0
      },
      skippedDetails: [],
      processedProfiles: {
        owner: null,
        family: []
      },
      currentRanking: [],
      playerSummary: null,
      tagsLoaded: 0,
      isBusy: false
    };
  }

  async function runLookup() {
    var runId = ++currentRunId;
    var primaryInput = elements.primaryProfile.value.trim();
    var workerEndpoint = getWorkerEndpoint();

    if (!primaryInput || !workerEndpoint) {
      addLog("Faltan el perfil principal o el endpoint del Cloudflare Worker. Configuralo en config.js.", "error");
      return;
    }

    saveSettings();
    state = createEmptyState();
    setBusy(true);
    clearLogs();
    setView("loading");
    updateProgress("Preparando perfiles.", 0, 1);
    var familyInputs = getFamilyInputs();
    updateSummary();

    try {
      var primarySteamId = await resolveSteamInput(primaryInput);
      if (runId !== currentRunId) return;

      addLog("Perfil principal resuelto: " + primarySteamId + ".", "ok");
      updateProgress("Cargando biblioteca principal.", 0, 1);

      var ownerPayload = await Promise.all([
        fetchOwnedGames(primarySteamId),
        fetchPlayerSummary(primarySteamId).catch(function () {
          return null;
        })
      ]);
      if (runId !== currentRunId) return;

      var ownerGames = ownerPayload[0];
      state.playerSummary = ownerPayload[1];
      state.ownedGames = normalizeGames(ownerGames, "owned", primarySteamId);
      state.processedProfiles.owner = {
        input: primaryInput,
        steamId: primarySteamId,
        visibleGames: state.ownedGames.length
      };

      addLog("Biblioteca principal: " + state.ownedGames.length + " juegos visibles.", "ok");
      updateSummary();

      if (familyInputs.length) {
        await processFamilyProfiles(familyInputs, runId);
      }

      await ensureTagsForSelection(runId);
    } catch (error) {
      addLog(readableError(error), "error");
      updateProgress("No se pudo completar el analisis.", 0, 1);
      setView("idle");
    } finally {
      if (runId === currentRunId) {
        setBusy(false);
        updateSummary();
      }
    }
  }

  async function processFamilyProfiles(familyInputs, runId) {
    var ownAppIds = new Set(state.ownedGames.map(function (game) {
      return game.appid;
    }));
    var familyAppIds = new Set();

    for (var index = 0; index < familyInputs.length; index += 1) {
      if (runId !== currentRunId) return;

      var input = familyInputs[index];
      updateProgress("Resolviendo perfil familiar " + (index + 1) + " de " + familyInputs.length + ".", index, familyInputs.length);

      try {
        var steamId = await resolveSteamInput(input);
        var games = normalizeGames(await fetchOwnedGames(steamId), "family", steamId);
        var profileInfo = {
          input: input,
          steamId: steamId,
          visibleGames: games.length,
          eligibleGames: 0
        };

        state.processedProfiles.family.push(profileInfo);
        addLog("Familiar " + steamId + ": " + games.length + " juegos visibles.", "ok");
        await filterFamilyGames(games, ownAppIds, familyAppIds, profileInfo, runId);
      } catch (error) {
        state.processedProfiles.family.push({
          input: input,
          error: readableError(error)
        });
        addLog("Perfil familiar omitido: " + readableError(error), "error");
      }

      updateSummary();
    }
  }

  async function filterFamilyGames(games, ownAppIds, familyAppIds, profileInfo, runId) {
    var candidates = [];

    games.forEach(function (game) {
      if (ownAppIds.has(game.appid) || familyAppIds.has(game.appid)) {
        recordSkipped("duplicateFamily", game);
        return;
      }

      familyAppIds.add(game.appid);
      candidates.push(game);
    });

    var completed = 0;

    await processWithConcurrency(candidates, STORE_CONCURRENCY, async function (game) {
      if (runId !== currentRunId) return;

      try {
        var details = await getAppDetails(game.appid);
        if (details.type !== "game") {
          recordSkipped("notShareableFamily", game, "Steam Store lo marca como '" + details.type + "', no como juego.");
          return;
        }

        if (details.isFree) {
          recordSkipped("freeFamily", game);
          return;
        }

        if (!details.familySharing) {
          recordSkipped("notShareableFamily", game);
          return;
        }

        familyAppIds.add(game.appid);
        state.familyGames.push({
          appid: game.appid,
          name: game.name || details.name || String(game.appid),
          source: "family",
          ownerSteamId: game.ownerSteamId
        });
        profileInfo.eligibleGames += 1;
      } catch (error) {
        recordSkipped("unknownEligibility", game);
        addLog("No se pudo validar Family Sharing de " + game.name + " (" + game.appid + ").", "error");
      } finally {
        completed += 1;
        updateProgress("Comprobando Family Sharing.", completed, candidates.length || 1);
        updateSummary();
      }
    });
  }

  async function ensureTagsForSelection(runId) {
    var selectedGames = getSelectedGames();
    selectedGames.forEach(function (game) {
      if (!state.tagCache.has(game.appid)) {
        var cached = readCache("toptag:tags:v2:" + game.appid);
        if (cached) {
          state.tagCache.set(game.appid, cached);
          if (!Object.keys(cached).length) {
            recordSkipped("noTags", game);
          }
        }
      }
    });

    var missingGames = selectedGames.filter(function (game) {
      return !state.tagCache.has(game.appid);
    });

    if (!selectedGames.length) {
      renderEmptyResults("No hay juegos visibles para analizar.");
      return;
    }

    var completed = 0;
    var batches = chunkArray(missingGames, TAG_BATCH_SIZE);

    await processWithConcurrency(batches, TAG_CONCURRENCY, async function (batch) {
      if (runId && runId !== currentRunId) return;

      try {
        var tagsByAppId = await getSteamTags(batch.map(function (game) {
          return game.appid;
        }));

        batch.forEach(function (game) {
          var tags = tagsByAppId[String(game.appid)] || {};
          state.tagCache.set(game.appid, tags);
          writeCache("toptag:tags:v2:" + game.appid, tags);
          state.tagsLoaded += 1;

          if (!Object.keys(tags).length) {
            recordSkipped("noTags", game);
          }
        });
      } catch (error) {
        batch.forEach(function (game) {
          state.tagCache.set(game.appid, {});
          writeCache("toptag:tags:v2:" + game.appid, {});
          recordSkipped("failedTags", game);
        });
        addLog("No se pudieron cargar tags de Steam para " + batch.length + " juegos.", "error");
      } finally {
        completed += batch.length;
        updateProgress("Cargando tags de Steam.", completed, missingGames.length || 1);
        updateSummary();
      }
    });

    updateProgress("Analisis completado.", selectedGames.length, selectedGames.length);
    renderResults();
  }

  function getSelectedGames() {
    var gamesById = new Map();

    state.ownedGames.forEach(function (game) {
      gamesById.set(game.appid, game);
    });

    if (elements.includeFamily.checked) {
      state.familyGames.forEach(function (game) {
        if (!gamesById.has(game.appid)) {
          gamesById.set(game.appid, game);
        }
      });
    }

    return Array.from(gamesById.values());
  }

  function renderResults() {
    var selectedGames = getSelectedGames();
    var ranking = buildTagRanking(selectedGames).slice(0, 20);
    state.currentRanking = ranking;
    closeTagModal();
    renderPlayerCard();

    if (!ranking.length) {
      renderEmptyResults("No se encontraron tags para los juegos seleccionados.");
      return;
    }

    elements.tagsTableBody.textContent = "";

    ranking.forEach(function (entry, index) {
      var row = document.createElement("tr");
      appendCell(row, String(index + 1));
      appendTagCell(row, entry);
      appendCell(row, String(entry.count));
      appendCell(row, formatHours(entry.primaryPlaytimeMinutes));
      appendCell(row, entry.examples.join(", "), "examples");
      elements.tagsTableBody.appendChild(row);
    });

    var sourceText = elements.includeFamily.checked && state.familyGames.length
      ? selectedGames.length + " juegos, Family Sharing incluido"
      : selectedGames.length + " juegos propios";
    elements.resultMode.textContent = sourceText + ".";
    setView("results");
  }

  function renderEmptyResults(message) {
    renderPlayerCard();
    state.currentRanking = [];
    closeTagModal();
    elements.tagsTableBody.textContent = "";
    var row = document.createElement("tr");
    var cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-cell";
    cell.textContent = message;
    row.appendChild(cell);
    elements.tagsTableBody.appendChild(row);
    elements.resultMode.textContent = message;
    setView("results");
  }

  function renderPlayerCard() {
    var owner = state.processedProfiles.owner;
    if (!owner) {
      elements.playerCard.hidden = true;
      return;
    }

    var summary = state.playerSummary || {};
    var name = summary.personaName || "Perfil de Steam";
    var avatar = summary.avatarFull || summary.avatarMedium || "";

    elements.playerName.textContent = name;
    elements.playerSteamId.textContent = "SteamID64 " + owner.steamId;
    elements.playerCard.hidden = false;

    if (avatar) {
      elements.playerAvatar.src = avatar;
      elements.playerAvatar.alt = "Avatar de " + name;
      elements.playerAvatar.hidden = false;
    } else {
      elements.playerAvatar.removeAttribute("src");
      elements.playerAvatar.alt = "";
      elements.playerAvatar.hidden = true;
    }
  }

  function buildTagRanking(games) {
    var tags = new Map();

    games.forEach(function (game) {
      var gameTags = state.tagCache.get(game.appid) || {};

      Object.keys(gameTags).forEach(function (tagName) {
        var normalized = tagName.trim();
        if (!normalized) return;

        if (!tags.has(normalized)) {
          tags.set(normalized, {
            name: normalized,
            count: 0,
            weightSum: 0,
            primaryPlaytimeMinutes: 0,
            games: [],
            examples: []
          });
        }

        var entry = tags.get(normalized);
        entry.count += 1;
        entry.weightSum += Number(gameTags[tagName]) || 0;
        if (game.source === "owned") {
          entry.primaryPlaytimeMinutes += Number(game.playtimeMinutes) || 0;
        }

        entry.games.push({
          appid: game.appid,
          name: game.name || String(game.appid),
          playtimeMinutes: game.source === "owned" ? Number(game.playtimeMinutes) || 0 : 0,
          source: game.source
        });
      });
    });

    return Array.from(tags.values()).map(function (entry) {
      entry.games = entry.games.sort(compareTagGames);
      entry.examples = entry.games.slice(0, 4).map(function (example) {
        return example.name;
      });

      return entry;
    }).sort(function (left, right) {
      if (right.count !== left.count) return right.count - left.count;
      if (right.weightSum !== left.weightSum) return right.weightSum - left.weightSum;
      return left.name.localeCompare(right.name);
    });
  }

  function compareTagGames(left, right) {
    if (right.playtimeMinutes !== left.playtimeMinutes) {
      return right.playtimeMinutes - left.playtimeMinutes;
    }

    if (left.source !== right.source) {
      return left.source === "owned" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  }

  async function resolveSteamInput(input) {
    var parsed = parseSteamInput(input);

    if (parsed.type === "steamid64") {
      return parsed.value;
    }

    if (parsed.type === "accountid") {
      return accountIdToSteamId64(parsed.value);
    }

    if (parsed.type === "vanity") {
      return resolveVanity(parsed.value);
    }

    throw new Error("Formato de perfil no reconocido: " + input);
  }

  function parseSteamInput(rawInput) {
    var input = rawInput.trim();
    var urlMatch = input.match(/steamcommunity\.com\/(?:profiles|id)\/([^/?#\s]+)/i);

    if (urlMatch) {
      var value = decodeURIComponent(urlMatch[1]);
      if (/^\d{17}$/.test(value)) {
        return { type: "steamid64", value: value };
      }
      return { type: "vanity", value: value };
    }

    var steam3 = input.match(/^\[?U:1:(\d+)\]?$/i);
    if (steam3) {
      return { type: "accountid", value: steam3[1] };
    }

    var steam2 = input.match(/^STEAM_[0-5]:([0-1]):(\d+)$/i);
    if (steam2) {
      return {
        type: "accountid",
        value: String(BigInt(steam2[2]) * 2n + BigInt(steam2[1]))
      };
    }

    if (/^\d{17}$/.test(input)) {
      return { type: "steamid64", value: input };
    }

    if (/^\d{1,10}$/.test(input)) {
      return { type: "accountid", value: input };
    }

    var vanity = input.replace(/^https?:\/\//i, "").replace(/^steamcommunity\.com\/id\//i, "");
    vanity = vanity.replace(/[/?#].*$/, "").trim();
    if (/^[A-Za-z0-9_-]{2,32}$/.test(vanity)) {
      return { type: "vanity", value: vanity };
    }

    return { type: "unknown", value: input };
  }

  async function resolveVanity(vanity) {
    var payload = await apiGet("/resolve-vanity", { vanity: vanity });

    if (!payload.steamid) {
      throw new Error("No se pudo resolver el vanity '" + vanity + "'.");
    }

    return payload.steamid;
  }

  function accountIdToSteamId64(accountId) {
    return String(STEAM_ID_BASE + BigInt(accountId));
  }

  async function fetchOwnedGames(steamId) {
    var payload = await apiGet("/owned-games", { steamid: steamId });

    if (!Array.isArray(payload.games)) {
      return [];
    }

    return payload.games;
  }

  async function fetchPlayerSummary(steamId) {
    return apiGet("/player-summary", { steamid: steamId });
  }

  function normalizeGames(games, source, ownerSteamId) {
    var seen = new Set();
    var normalized = [];

    games.forEach(function (game) {
      var appid = Number(game.appid);
      if (!Number.isFinite(appid) || seen.has(appid)) return;

      seen.add(appid);
      normalized.push({
        appid: appid,
        name: game.name || String(appid),
        source: source,
        ownerSteamId: ownerSteamId,
        playtimeMinutes: source === "owned" ? Number(game.playtime_forever) || 0 : 0
      });
    });

    return normalized;
  }

  async function getAppDetails(appid) {
    var cacheKey = "toptag:appdetails:v1:" + appid;
    var cached = readCache(cacheKey);
    if (cached) return cached;

    var data = await apiGet("/appdetails", { appid: appid });
    var details = {
      appid: appid,
      name: data.name || String(appid),
      type: data.type || "unknown",
      isFree: Boolean(data.isFree),
      familySharing: Boolean(data.familySharing)
    };

    writeCache(cacheKey, details);
    return details;
  }

  async function getSteamTags(appids) {
    var payload = await apiGet("/steam-tags", {
      appids: appids.join(",")
    });
    var tagsByAppId = payload.tagsByAppId && typeof payload.tagsByAppId === "object"
      ? payload.tagsByAppId
      : {};
    var cleanTagsByAppId = {};

    Object.keys(tagsByAppId).forEach(function (appid) {
      var tags = tagsByAppId[appid] && typeof tagsByAppId[appid] === "object"
        ? tagsByAppId[appid]
        : {};
      var cleanTags = {};

      Object.keys(tags).forEach(function (name) {
        var value = Number(tags[name]);
        if (name.trim() && Number.isFinite(value)) {
          cleanTags[name] = value;
        }
      });

      cleanTagsByAppId[appid] = cleanTags;
    });

    return cleanTagsByAppId;
  }

  async function apiGet(path, params) {
    var endpoint = getWorkerEndpoint();
    var url = new URL(endpoint + path);

    Object.keys(params || {}).forEach(function (key) {
      url.searchParams.set(key, params[key]);
    });

    var response;

    try {
      response = await fetch(url.toString(), {
        method: "GET",
        cache: "default"
      });
    } catch (error) {
      throw new Error(networkErrorMessage(error));
    }

    var text = await response.text();

    if (!response.ok) {
      throw new Error(httpErrorMessage(response.status, text, path));
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("Respuesta no valida del Worker.");
    }
  }

  function extractErrorMessage(text) {
    try {
      var payload = JSON.parse(text);
      return payload.error || text.slice(0, 120);
    } catch (error) {
      return text.slice(0, 120);
    }
  }

  function networkErrorMessage(error) {
    var message = String(error && error.message ? error.message : error).toLowerCase();

    if (message.indexOf("failed to fetch") !== -1 || message.indexOf("networkerror") !== -1) {
      return "No se pudo conectar con TopTag. Revisa tu conexion o que el Cloudflare Worker este publicado y permitido en CORS.";
    }

    return "No se pudo conectar con TopTag: " + (error.message || String(error));
  }

  function httpErrorMessage(status, text, path) {
    var upstream = extractErrorMessage(text);

    if (path === "/resolve-vanity" && status === 404) {
      return "No encontramos ese perfil de Steam. Revisa que el vanity o la URL esten bien escritos.";
    }

    if (path === "/owned-games" && status === 400) {
      return "El SteamID no parece valido. Prueba con la URL completa del perfil o con un SteamID64.";
    }

    if (path === "/owned-games" && (status === 401 || status === 403)) {
      return "Steam no permite leer esa biblioteca. Puede que el perfil sea privado o que la Steam API key del Worker no sea valida.";
    }

    if (status === 404) {
      return "No se encontro informacion para esa peticion. Revisa el perfil o intenta con una URL completa de Steam.";
    }

    if (status >= 500) {
      return "TopTag no pudo consultar Steam ahora mismo. Prueba otra vez en unos minutos.";
    }

    return "No se pudo completar la consulta: " + upstream;
  }

  function normalizeWorkerEndpoint(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function getWorkerEndpoint() {
    return normalizeWorkerEndpoint(elements.workerEndpoint.value || configuredWorkerEndpoint());
  }

  function configuredWorkerEndpoint() {
    var config = window.TOPTAG_CONFIG || {};
    return normalizeWorkerEndpoint(config.workerEndpoint);
  }

  function getFamilyInputs() {
    if (!elements.includeFamily.checked) {
      return [];
    }

    var parsed = parseFamilyInputs(elements.familyProfiles.value);

    if (parsed.length > MAX_FAMILY_PROFILES) {
      parsed.slice(MAX_FAMILY_PROFILES).forEach(function (input) {
        recordSkipped("extraProfiles", { name: input });
      });
      addLog("Solo se procesaran los primeros " + MAX_FAMILY_PROFILES + " perfiles familiares.", "error");
    }

    return parsed.slice(0, MAX_FAMILY_PROFILES);
  }

  function parseFamilyInputs(value) {
    var unique = [];
    var seen = new Set();

    String(value || "")
      .split(/\r?\n|,/)
      .map(function (line) {
        return line.trim();
      })
      .filter(Boolean)
      .forEach(function (input) {
        var key = input.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(input);
        }
      });

    return unique;
  }

  function updateSummary() {
    var selectedGames = getSelectedGames();
    var loadedTags = selectedGames.filter(function (game) {
      return state.tagCache.has(game.appid);
    }).length;
    var skippedTotal = sumSkipped();

    elements.ownedCount.textContent = String(state.ownedGames.length);
    elements.familyEligibleCount.textContent = String(state.familyGames.length);
    elements.tagsLoadedCount.textContent = String(loadedTags);
    elements.skippedCount.textContent = String(skippedTotal);
    elements.skippedDetailsButton.disabled = skippedTotal === 0;
  }

  function sumSkipped() {
    return Object.keys(state.skipped).reduce(function (sum, key) {
      return sum + state.skipped[key];
    }, 0);
  }

  function recordSkipped(kind, item, reason) {
    if (!Object.prototype.hasOwnProperty.call(state.skipped, kind)) {
      return;
    }

    state.skipped[kind] += 1;
    state.skippedDetails.push({
      kind: kind,
      appid: item && item.appid,
      name: skippedItemName(item),
      source: item && item.source ? item.source : "",
      reason: reason || SKIPPED_REASONS[kind] || "Omitido"
    });
  }

  function skippedItemName(item) {
    if (!item) {
      return "Elemento omitido";
    }

    return item.name || item.input || (item.appid ? "AppID " + item.appid : "Elemento omitido");
  }

  function addLog(message, type) {
    state.logs.push({ message: message, type: type || "info" });
    if (type === "error") {
      elements.formMessage.textContent = message;
    }
  }

  function clearLogs() {
    state.logs = [];
    elements.formMessage.textContent = "";
  }

  function showToast(message, type) {
    var toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "success");
    toast.textContent = message;
    elements.toastRoot.appendChild(toast);

    window.setTimeout(function () {
      toast.classList.add("toast-out");
      window.setTimeout(function () {
        toast.remove();
      }, 220);
    }, type === "error" ? 4200 : 2600);
  }

  async function copyShareUrl() {
    writeFormToUrl();

    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast("Enlace copiado al portapapeles.", "success");
    } catch (error) {
      showToast("No se pudo copiar el enlace.", "error");
    }
  }

  function appendCell(row, text, className) {
    var cell = document.createElement("td");
    if (className) {
      cell.className = className;
    }
    cell.textContent = text;
    row.appendChild(cell);
  }

  function appendTagCell(row, entry) {
    var cell = document.createElement("td");
    var button = document.createElement("button");
    button.className = "tag-trigger";
    button.type = "button";
    button.textContent = entry.name;
    button.addEventListener("click", function () {
      openTagModal(entry);
    });

    cell.appendChild(button);
    row.appendChild(cell);
  }

  function openTagModal(entry) {
    elements.tagModal.classList.remove("is-skipped-modal");
    elements.tagModalTitle.textContent = entry.name;
    elements.tagModalMeta.textContent = entry.count + " juegos - " + formatHours(entry.primaryPlaytimeMinutes) + " del usuario principal";
    elements.tagModalFirstHeader.textContent = "Juego";
    elements.tagModalSecondHeader.textContent = "Horas";
    elements.tagModalGames.textContent = "";

    entry.games.forEach(function (game) {
      var row = document.createElement("div");
      var title = document.createElement("div");
      var name = document.createElement("strong");
      var source = document.createElement("span");
      var hours = document.createElement("span");

      row.className = "tag-modal-game";
      row.setAttribute("role", "row");
      title.className = "tag-modal-game-title";
      title.setAttribute("role", "cell");
      hours.className = "tag-modal-game-hours";
      hours.setAttribute("role", "cell");

      name.textContent = game.name;
      source.textContent = game.source === "owned" ? "Propio" : "Family Sharing";
      hours.textContent = game.source === "owned" ? formatHours(game.playtimeMinutes) : "-";

      title.appendChild(name);
      title.appendChild(source);
      row.appendChild(title);
      row.appendChild(hours);
      elements.tagModalGames.appendChild(row);
    });

    elements.tagModal.hidden = false;
    elements.tagModalClose.focus();
  }

  function openSkippedModal() {
    var details = state.skippedDetails.slice().sort(function (left, right) {
      var reasonOrder = left.reason.localeCompare(right.reason);
      if (reasonOrder !== 0) return reasonOrder;
      return left.name.localeCompare(right.name);
    });
    var skippedTotal = sumSkipped();

    elements.tagModal.classList.add("is-skipped-modal");
    elements.tagModalTitle.textContent = "Omitidos";
    elements.tagModalMeta.textContent = skippedTotal === 1
      ? "1 elemento omitido durante el analisis."
      : skippedTotal + " elementos omitidos durante el analisis.";
    elements.tagModalFirstHeader.textContent = "Juego o perfil";
    elements.tagModalSecondHeader.textContent = "Motivo";
    elements.tagModalGames.textContent = "";

    if (!details.length) {
      appendSkippedRow({
        name: "No hay omitidos",
        reason: "Todos los juegos procesados tienen datos suficientes.",
        source: ""
      });
    } else {
      details.forEach(appendSkippedRow);
    }

    elements.tagModal.hidden = false;
    elements.tagModalClose.focus();
  }

  function appendSkippedRow(detail) {
    var row = document.createElement("div");
    var title = document.createElement("div");
    var name = document.createElement("strong");
    var source = document.createElement("span");
    var reason = document.createElement("span");

    row.className = "tag-modal-game";
    row.setAttribute("role", "row");
    title.className = "tag-modal-game-title";
    title.setAttribute("role", "cell");
    reason.className = "tag-modal-game-reason";
    reason.setAttribute("role", "cell");

    name.textContent = detail.name;
    source.textContent = skippedDetailMeta(detail);
    reason.textContent = detail.reason;

    title.appendChild(name);
    if (source.textContent) {
      title.appendChild(source);
    }
    row.appendChild(title);
    row.appendChild(reason);
    elements.tagModalGames.appendChild(row);
  }

  function skippedDetailMeta(detail) {
    var parts = [];

    if (detail.appid) {
      parts.push("AppID " + detail.appid);
    }

    if (detail.source === "owned") {
      parts.push("Propio");
    } else if (detail.source === "family") {
      parts.push("Family Sharing");
    }

    return parts.join(" - ");
  }

  function closeTagModal() {
    elements.tagModal.hidden = true;
  }

  function formatHours(minutes) {
    var hours = (Number(minutes) || 0) / 60;

    if (hours === 0) {
      return "0 h";
    }

    return new Intl.NumberFormat("es-ES", {
      maximumFractionDigits: hours < 10 ? 1 : 0,
      minimumFractionDigits: hours < 10 ? 1 : 0
    }).format(hours) + " h";
  }

  function updateProgress(message, current, total) {
    var safeTotal = Math.max(Number(total) || 1, 1);
    var safeCurrent = Math.max(Number(current) || 0, 0);
    var ratio = Math.min(safeCurrent / safeTotal, 1);

    elements.statusText.textContent = message;
    elements.progressCount.textContent = safeCurrent + " / " + safeTotal;
    elements.progressBar.style.width = Math.round(ratio * 100) + "%";
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;
    elements.submitButton.disabled = isBusy;
    elements.includeFamily.disabled = isBusy;
    elements.familyProfiles.disabled = isBusy;
    elements.shareButton.disabled = isBusy;
    elements.clearCacheButton.disabled = isBusy;
    elements.submitButton.textContent = isBusy ? "Analizando..." : "Analizar biblioteca";
  }

  function setView(view) {
    document.body.dataset.view = view;
  }

  function syncFamilyField() {
    elements.familyProfilesField.hidden = !elements.includeFamily.checked;
  }

  function readCache(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;

      var entry = JSON.parse(raw);
      if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL) {
        localStorage.removeItem(key);
        return null;
      }

      return entry.value;
    } catch (error) {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({
        fetchedAt: Date.now(),
        value: value
      }));
    } catch (error) {
      addLog("No queda espacio para cachear mas datos localmente.", "error");
    }
  }

  function clearAppCache() {
    var keys = [];

    for (var index = 0; index < localStorage.length; index += 1) {
      var key = localStorage.key(index);
      if (key && (key.indexOf("toptag:appdetails:") === 0 || key.indexOf("toptag:tags:") === 0)) {
        keys.push(key);
      }
    }

    keys.forEach(function (key) {
      localStorage.removeItem(key);
    });

    state.tagCache.clear();
    state.tagsLoaded = 0;
  }

  function restoreSettings() {
    elements.workerEndpoint.value = localStorage.getItem("toptag:settings:workerEndpoint") || configuredWorkerEndpoint();
    localStorage.removeItem("toptag:settings:apiKey");
  }

  function restoreFormFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var profile = params.get("profile") || "";
    var families = params.getAll("family").filter(Boolean);

    if (profile) {
      elements.primaryProfile.value = profile;
    }

    if (families.length) {
      elements.familyProfiles.value = families.slice(0, MAX_FAMILY_PROFILES).join("\n");
    }

    elements.includeFamily.checked = families.length > 0;
    return Boolean(profile);
  }

  function writeFormToUrl() {
    var url = new URL(window.location.href);
    var params = url.searchParams;
    var profile = elements.primaryProfile.value.trim();
    var families = elements.includeFamily.checked
      ? parseFamilyInputs(elements.familyProfiles.value).slice(0, MAX_FAMILY_PROFILES)
      : [];

    if (profile) {
      params.set("profile", profile);
    } else {
      params.delete("profile");
    }

    params.delete("family");
    families.forEach(function (family) {
      params.append("family", family);
    });

    window.history.replaceState(null, "", url.toString());
  }

  function saveSettings() {
    localStorage.setItem("toptag:settings:workerEndpoint", normalizeWorkerEndpoint(elements.workerEndpoint.value));
  }

  function readableError(error) {
    if (!error) return "Error desconocido.";
    return error.message || String(error);
  }

  function chunkArray(items, size) {
    var chunks = [];
    var safeSize = Math.max(Number(size) || 1, 1);

    for (var index = 0; index < items.length; index += safeSize) {
      chunks.push(items.slice(index, index + safeSize));
    }

    return chunks;
  }

  async function processWithConcurrency(items, limit, worker) {
    var cursor = 0;
    var workerCount = Math.min(Math.max(limit, 1), items.length);
    var runners = [];

    async function runNext() {
      while (cursor < items.length) {
        var index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    }

    for (var index = 0; index < workerCount; index += 1) {
      runners.push(runNext());
    }

    await Promise.all(runners);
  }
})();
