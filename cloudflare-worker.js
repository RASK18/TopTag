var FAMILY_CATEGORY_ID = 62;
var TAG_BATCH_LIMIT = 50;
var TAG_COUNT = 20;
var TAG_LANGUAGE = "english";
var TAG_COUNTRY_CODE = "US";
var DEFAULT_ALLOWED_ORIGINS = new Set([
  "null",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
]);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return handleOptions(request, env);
    }

    if (request.method !== "GET") {
      return json(request, env, { error: "Method not allowed" }, 405);
    }

    var cors = getCorsHeaders(request, env);
    if (!cors && request.headers.get("Origin")) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), {
        status: 403,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Vary": "Origin"
        }
      });
    }

    var url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json(request, env, { ok: true });
      }

      if (url.pathname === "/resolve-vanity") {
        return await resolveVanity(request, env, url);
      }

      if (url.pathname === "/owned-games") {
        return await ownedGames(request, env, url);
      }

      if (url.pathname === "/player-summary") {
        return await playerSummary(request, env, url);
      }

      if (url.pathname === "/appdetails") {
        return await appDetails(request, env, url);
      }

      if (url.pathname === "/steam-tags") {
        return await steamTags(request, env, url);
      }

      return json(request, env, { error: "Not found" }, 404);
    } catch (error) {
      return json(request, env, { error: error.message || "Unexpected error" }, error.status || 500);
    }
  }
};

async function resolveVanity(request, env, url) {
  requireSteamKey(env);

  var vanity = String(url.searchParams.get("vanity") || "").trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(vanity)) {
    throw httpError("Invalid vanity profile", 400);
  }

  var steamUrl = new URL("https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/");
  steamUrl.searchParams.set("key", env.STEAM_API_KEY);
  steamUrl.searchParams.set("vanityurl", vanity);

  var payload = await fetchJson(steamUrl.toString(), 0);
  var response = payload.response || {};

  if (response.success !== 1 || !response.steamid) {
    throw httpError("Steam could not resolve this vanity profile", 404);
  }

  return json(request, env, { steamid: response.steamid });
}

async function ownedGames(request, env, url) {
  requireSteamKey(env);

  var steamid = String(url.searchParams.get("steamid") || "").trim();
  if (!/^\d{17}$/.test(steamid)) {
    throw httpError("Invalid steamid", 400);
  }

  var steamUrl = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  steamUrl.searchParams.set("key", env.STEAM_API_KEY);
  steamUrl.searchParams.set("steamid", steamid);
  steamUrl.searchParams.set("include_appinfo", "1");
  steamUrl.searchParams.set("include_played_free_games", "1");
  steamUrl.searchParams.set("skip_unvetted_apps", "false");
  steamUrl.searchParams.set("format", "json");

  var payload = await fetchJson(steamUrl.toString(), 0);
  var games = payload.response && Array.isArray(payload.response.games)
    ? payload.response.games
    : [];

  return json(request, env, { games: games }, 200, { "Cache-Control": "no-store" });
}

async function playerSummary(request, env, url) {
  requireSteamKey(env);

  var steamid = String(url.searchParams.get("steamid") || "").trim();
  if (!/^\d{17}$/.test(steamid)) {
    throw httpError("Invalid steamid", 400);
  }

  var steamUrl = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
  steamUrl.searchParams.set("key", env.STEAM_API_KEY);
  steamUrl.searchParams.set("steamids", steamid);

  var payload = await fetchJson(steamUrl.toString(), 3600);
  var players = payload.response && Array.isArray(payload.response.players)
    ? payload.response.players
    : [];
  var player = players[0];

  if (!player) {
    throw httpError("Steam did not return this player profile", 404);
  }

  return json(request, env, {
    steamid: player.steamid,
    personaName: player.personaname || "",
    profileUrl: player.profileurl || "",
    avatarMedium: player.avatarmedium || "",
    avatarFull: player.avatarfull || ""
  }, 200, { "Cache-Control": "public, max-age=3600" });
}

async function appDetails(request, env, url) {
  var appid = readAppId(url);
  var steamUrl = new URL("https://store.steampowered.com/api/appdetails");
  steamUrl.searchParams.set("appids", String(appid));
  steamUrl.searchParams.set("filters", "basic,categories");

  var payload = await fetchJson(steamUrl.toString(), readInt(env.STORE_CACHE_TTL_SECONDS, 86400));
  var envelope = payload[String(appid)];

  if (!envelope || !envelope.success || !envelope.data) {
    throw httpError("Steam Store did not return details for this app", 404);
  }

  var data = envelope.data;
  var categories = Array.isArray(data.categories) ? data.categories : [];
  var details = {
    appid: appid,
    name: data.name || String(appid),
    type: data.type || "unknown",
    isFree: Boolean(data.is_free),
    familySharing: categories.some(function (category) {
      return Number(category.id) === FAMILY_CATEGORY_ID
        || String(category.description || "").toLowerCase() === "family sharing";
    })
  };

  return json(request, env, details, 200, {
    "Cache-Control": "public, max-age=86400"
  });
}

async function steamTags(request, env, url) {
  requireSteamKey(env);

  var appids = readAppIds(url);
  var cacheTtl = readInt(env.TAG_CACHE_TTL_SECONDS, 604800);
  var input = {
    ids: appids.map(function (appid) {
      return { appid: appid };
    }),
    context: {
      language: TAG_LANGUAGE,
      country_code: TAG_COUNTRY_CODE
    },
    // xPaw documents include_tag_count on IStoreBrowseService/GetItems.
    data_request: {
      include_tag_count: TAG_COUNT
    }
  };

  var steamUrl = new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
  steamUrl.searchParams.set("key", env.STEAM_API_KEY);
  steamUrl.searchParams.set("input_json", JSON.stringify(input));

  var payload = await fetchJson(steamUrl.toString(), cacheTtl);
  var storeItems = payload.response && Array.isArray(payload.response.store_items)
    ? payload.response.store_items
    : [];
  var tagIds = collectTagIds(storeItems);
  var tagNames = await getTagNames(env, tagIds, cacheTtl);
  var missingAppIds = new Set(appids);
  var tagsByAppId = {};

  storeItems.forEach(function (item) {
    var appid = Number(item.appid || item.id);
    if (!Number.isInteger(appid) || appids.indexOf(appid) === -1) {
      return;
    }

    missingAppIds.delete(appid);
    tagsByAppId[String(appid)] = normalizeStoreTags(item.tags, tagNames);
  });

  return json(request, env, {
    tagsByAppId: tagsByAppId,
    missingAppIds: Array.from(missingAppIds)
  }, 200, {
    "Cache-Control": "public, max-age=" + cacheTtl
  });
}

async function fetchJson(url, cacheTtl) {
  var response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    },
    cf: cacheTtl > 0 ? {
      cacheEverything: true,
      cacheTtl: cacheTtl
    } : undefined
  });
  var text = await response.text();

  if (!response.ok) {
    throw httpError("Upstream request failed with HTTP " + response.status, response.status);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError("Upstream did not return valid JSON", 502);
  }
}

function readAppId(url) {
  var appid = Number(url.searchParams.get("appid"));
  if (!Number.isInteger(appid) || appid <= 0 || appid > 999999999) {
    throw httpError("Invalid appid", 400);
  }
  return appid;
}

function readAppIds(url) {
  var raw = String(url.searchParams.get("appids") || "").trim();
  var parts = raw.split(",").map(function (part) {
    return part.trim();
  }).filter(Boolean);
  var appids = [];
  var seen = new Set();

  if (!parts.length) {
    throw httpError("Missing appids", 400);
  }

  if (parts.length > TAG_BATCH_LIMIT) {
    throw httpError("Too many appids. Maximum is " + TAG_BATCH_LIMIT, 400);
  }

  parts.forEach(function (part) {
    var appid = Number(part);
    if (!Number.isInteger(appid) || appid <= 0 || appid > 999999999) {
      throw httpError("Invalid appid: " + part, 400);
    }

    if (!seen.has(appid)) {
      seen.add(appid);
      appids.push(appid);
    }
  });

  return appids;
}

function collectTagIds(storeItems) {
  var ids = new Set();

  storeItems.forEach(function (item) {
    var tags = Array.isArray(item.tags) ? item.tags : [];
    tags.forEach(function (tag) {
      var tagid = Number(tag.tagid);
      if (Number.isInteger(tagid) && tagid > 0) {
        ids.add(tagid);
      }
    });
  });

  return Array.from(ids);
}

async function getTagNames(env, tagIds, cacheTtl) {
  var tagNames = new Map();
  if (!tagIds.length) {
    return tagNames;
  }

  var tagListUrl = new URL("https://api.steampowered.com/IStoreService/GetTagList/v1/");
  tagListUrl.searchParams.set("key", env.STEAM_API_KEY);
  tagListUrl.searchParams.set("language", TAG_LANGUAGE);

  var tagListPayload = await fetchJson(tagListUrl.toString(), cacheTtl);
  var tagList = tagListPayload.response && Array.isArray(tagListPayload.response.tags)
    ? tagListPayload.response.tags
    : [];

  tagList.forEach(function (tag) {
    var tagid = Number(tag.tagid);
    if (Number.isInteger(tagid) && tag.name) {
      tagNames.set(tagid, String(tag.name));
    }
  });

  var missingTagIds = tagIds.filter(function (tagid) {
    return !tagNames.has(tagid);
  });

  if (missingTagIds.length) {
    var localizedUrl = new URL("https://api.steampowered.com/IStoreService/GetLocalizedNameForTags/v1/");
    localizedUrl.searchParams.set("key", env.STEAM_API_KEY);
    localizedUrl.searchParams.set("language", TAG_LANGUAGE);
    missingTagIds.forEach(function (tagid, index) {
      localizedUrl.searchParams.set("tagids[" + index + "]", String(tagid));
    });

    var localizedPayload = await fetchJson(localizedUrl.toString(), cacheTtl);
    var localizedTags = localizedPayload.response && Array.isArray(localizedPayload.response.tags)
      ? localizedPayload.response.tags
      : [];

    localizedTags.forEach(function (tag) {
      var tagid = Number(tag.tagid);
      var name = tag.name || tag.english_name;
      if (Number.isInteger(tagid) && name) {
        tagNames.set(tagid, String(name));
      }
    });
  }

  return tagNames;
}

function normalizeStoreTags(tags, tagNames) {
  var cleanTags = {};

  if (!Array.isArray(tags)) {
    return cleanTags;
  }

  tags.forEach(function (tag) {
    var tagid = Number(tag.tagid);
    var weight = Number(tag.weight);
    var name = tagNames.get(tagid);

    if (name && Number.isFinite(weight)) {
      cleanTags[name] = weight;
    }
  });

  return cleanTags;
}

function requireSteamKey(env) {
  if (!env.STEAM_API_KEY) {
    throw httpError("Missing STEAM_API_KEY secret", 500);
  }
}

function json(request, env, payload, status, extraHeaders) {
  var headers = Object.assign({
    "Content-Type": "application/json; charset=utf-8"
  }, getCorsHeaders(request, env) || {}, extraHeaders || {});

  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: headers
  });
}

function handleOptions(request, env) {
  var cors = getCorsHeaders(request, env);
  if (!cors) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: cors
  });
}

function getCorsHeaders(request, env) {
  var origin = request.headers.get("Origin");
  var allowed = allowedOrigins(env);

  if (!origin) {
    return {
      "Vary": "Origin"
    };
  }

  if (!allowed.has("*") && !allowed.has(origin)) {
    return null;
  }

  return {
    "Access-Control-Allow-Origin": allowed.has("*") ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function allowedOrigins(env) {
  var raw = String(env.ALLOWED_ORIGINS || "").trim();
  if (!raw) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  return new Set(raw.split(",").map(function (item) {
    return item.trim();
  }).filter(Boolean));
}

function readInt(value, fallback) {
  var parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function httpError(message, status) {
  var error = new Error(message);
  error.status = status;
  return error;
}
