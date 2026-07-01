## Goal
Make video generation complete successfully instead of failing with `Gateway request failed — HTTP 404`, while minimizing paid AI/video retries.

## What I found
- The app is calling the Vercel `@ai-sdk/gateway` video provider with a Lovable API key and a custom base URL: `https://ai.gateway.lovable.dev/v4/ai`.
- That provider posts to `/video-model`, but the Lovable AI Gateway request is not appearing in Lovable AI Gateway logs and the UI shows `HTTP 404`.
- This strongly indicates the video call is hitting the wrong gateway route/adapter, not that your prompt/script is bad.
- Script generation and metadata use the correct Lovable AI Gateway helper path already.

## Implementation plan
1. **Replace the broken video adapter**
   - Remove the `@ai-sdk/gateway` video path from `src/lib/media.functions.ts`.
   - Route video generation through a working Lovable-compatible video endpoint/tooling path instead of the unsupported `/v4/ai/video-model` URL.
   - Keep Veo 3.1 as the requested model where supported; if that endpoint returns a provider/model limitation, surface the exact provider message instead of generic failure text.

2. **Add a preflight check before spending video credits**
   - Validate API key availability, model route, duration, aspect ratio, and required input before creating a paid video generation request.
   - Fail fast with clear instructions if the gateway/model is unavailable, instead of charging/retrying blindly.

3. **Make video generation safer and cheaper**
   - Use the minimum valid Veo duration for the first successful clip.
   - Keep `maxRetries: 0` for terminal provider errors.
   - Do not auto-regenerate after a 400/402/403/404; show the exact cause and stop.
   - Only retry transient 429/5xx errors with a small backoff if needed.

4. **Harden the server pipeline**
   - Ensure video rows always move through clear statuses: generating, ready, or failed.
   - Preserve the script and metadata even when video generation fails so you do not have to pay for script generation again.
   - Store the generated MP4 in backend storage and return a signed URL.

5. **Improve the UI error and retry behavior**
   - Replace generic `Invalid error response format` with a readable provider-specific error.
   - Disable the retry button for non-retryable failures unless the user changes input/settings.
   - Show a clear next action when credits, OAuth, route, or model access is the blocker.

6. **Validate without wasting video credits first**
   - Run a no-spend/preflight path and check server logs.
   - Confirm script/metadata persistence still works.
   - Only run one real minimal video generation attempt after the route is confirmed valid.
   - Verify the resulting library item has a playable MP4 URL.

## Technical notes
- Primary file: `src/lib/media.functions.ts`.
- UI file: `src/routes/_authenticated/generate.tsx`.
- I will not create mock videos or fake success states.
- If Veo 3.1 is not available through the runtime gateway for this project, I will make the app say exactly that and point to the required enablement step, rather than burning more retries.