## Plan

1. **Make Shorts format non-optional before upload**
   - Add a server-side “Shorts-safe MP4” preparation step in the YouTube upload flow.
   - Before sending to YouTube, inspect the MP4 dimensions/duration.
   - If it is not exactly vertical 9:16, repackage it into a vertical 1080x1920 canvas with the original video centered and a blurred moving copy behind it.
   - This guarantees YouTube receives a vertical Short-style file, not a landscape video file.

2. **Fix the fast splitter fallback that can still create landscape clips**
   - The current fast stream-copy path preserves original resolution, so if the source is landscape it can upload as landscape even though the UI preview is 9:16.
   - Keep the fast path, but add a validation guard: any generated split clip that is not vertical gets converted once into the centered vertical blur layout.
   - Keep the existing cinematic polish and 4K features working as-is.

3. **Fix 4K upgrade output to stay Shorts-safe**
   - Update the 4K worker/upscale paths so they use the same centered vertical blur composition instead of simple crop-only scaling.
   - This avoids cutting the subject off and keeps upgraded files in 2160x3840 vertical format.

4. **Strengthen YouTube Shorts metadata**
   - Keep auto-appending `#Shorts` to title/description and Shorts tags.
   - Store the actually-uploaded metadata back to the library so the app reflects what YouTube received.
   - Add upload-stage checks so normal upload, one-click publish, and bulk publish all use the same Shorts-safe path.

5. **Add clear safety errors instead of silent bad uploads**
   - If a clip is over 60 seconds, stop upload with a clear message.
   - If format preparation fails, stop instead of uploading a landscape/regular video.

6. **Verify without breaking existing workflow**
   - Check the splitter, library upload dialog, one-click publish, and bulk publish all still call the same upload function.
   - Confirm generated clips remain selectable and bulk-uploadable from both Long → Shorts and Library.