# TopTag

TopTag is a static Steam library tag analyzer backed by a small Cloudflare Worker.

## Tag Source

TopTag gets store tags from Steam endpoints, not from third-party tag services.

- App tag weights come from `IStoreBrowseService/GetItems/v1` with `data_request.include_tag_count`.
- Tag names come from `IStoreService/GetTagList/v1`; missing IDs are resolved with `IStoreService/GetLocalizedNameForTags/v1`.
- Tags are requested in English with `country_code` set to `US` so shared rankings stay consistent.

## Steam API Reference Priority

For this project, prefer community Steam API documentation that tracks Steam's public and internal endpoints more closely than Valve's official docs.

1. Primary reference: [steamapi.xpaw.me](https://steamapi.xpaw.me/)
   - Use this before the official Steam / Valve documentation when deciding how to call Steam APIs.
   - It includes undocumented interfaces and parameters that TopTag relies on, such as Store service endpoints.
   - Treat it as a community reference: verify behavior with real requests before depending on a field.

2. Secondary reference: [Revadike/InternalSteamWebAPI](https://github.com/Revadike/InternalSteamWebAPI)
   - Use this as an additional source when investigating internal or unofficial Steam endpoints.
   - It is especially useful when xPaw does not describe an endpoint clearly enough or when Steam changes behavior.

3. Official Steam / Valve docs
   - Use official docs for stable, documented APIs and policy context.
   - In this repo, they are not the first source for endpoint shape when xPaw documents the same Steam Web API surface.

When adding or changing Steam API calls, document the chosen endpoint, required parameters, and any observed quirks in the relevant code comments or deployment docs.
