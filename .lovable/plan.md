## Goal

Make the GitHub workflow stop failing and make the whole flow match your expectation:

```text
Test Flow in app -> creates preview video only
Run workflow in GitHub -> uploads that ready test video to YouTube
Automatic schedule -> creates and uploads 3 shorts/day when laptop is off
```

## What is wrong right now

The GitHub workflow is still calling `/api/public/autopilot/tick?force=1`, which tries to create a brand-new autopilot job on GitHub. That path depends on server-side image/TTS generation and can fail before upload. It also does not know about the test video you already generated in the app.

So your app Test Flow works, but GitHub Run Workflow is testing the old all-in-one path instead of uploading the ready test short.

## Implementation plan

1. **Add a dedicated GitHub manual-upload endpoint**
  - Create a public protected endpoint like `/api/public/autopilot/run-workflow`.
  - It will verify `AUTOPILOT_SECRET`.
  - In manual test mode, it will find the latest `ready` video with no `youtube_video_id`.
  - It will upload that existing video to YouTube.
  - It will save the YouTube video ID back to the video row.
  - It will return clean JSON: success/failure, video ID, YouTube URL.
2. **Reuse the existing YouTube upload logic safely**
  - Extract shared upload helper code from `uploadVideoToYouTube` so both the app button and GitHub endpoint use the same working upload path.
  - Keep the current app `Run Workflow` button working.
  - Keep progress UI in the app.
3. **Change GitHub manual Run Workflow behavior**
  - Update `scripts/autopilot-runner.mjs` so when `force_test=true`, it does NOT generate another short.
  - Instead it calls the new endpoint to upload the latest test video already saved in Library.
  - If no ready test video exists, GitHub should show a clear message: “Generate Test Flow first.”
4. **Keep automatic 3/day scheduling intact**
  - Normal hourly GitHub schedule will still call `/api/public/autopilot/tick`.
  - Scheduled mode will keep generating, rendering, and uploading due shorts when laptop is off.
  - Manual test mode will be separate and will not disturb the existing autopilot schedule.
5. **Improve errors shown in GitHub logs**
  - Replace confusing `Tick failed 401` / generic `exit code 1` with exact causes:
    - secret mismatch
    - no YouTube connection
    - no ready test video
    - upload permission missing
    - YouTube API upload error
6. **Verification after implementation**
  - Check the code paths for:
    - Test Flow creates a ready video only.
    - GitHub manual workflow uploads an existing ready video.
    - Scheduled workflow still generates/uploads based on slots.
  - Use available runtime/server logs and a safe endpoint test where possible without wasting generation credits.

## Expected result just for test 

After this, your test process will be:

1. Click **Test Flow** in Autopilot tab.
2. Confirm the video preview appears.
3. Go to GitHub Actions and click **Run workflow** with `force_test=true`.
4. GitHub uploads that same ready test video to YouTube.
5. The database stores the YouTube Video ID and the app shows the YouTube link.

For real autopilot, leave the switch enabled and GitHub Actions will run hourly, publishing up to your configured 3 shorts/day at your selected times.  
  
and after it is success the daily 3 shorts should be automatic upload by using these workflow mkae sure user even should not know that the video is published like it should work full automation and dont need a user intraction anymore after this

&nbsp;

&nbsp;