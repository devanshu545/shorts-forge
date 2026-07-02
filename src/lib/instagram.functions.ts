import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const SaveSchema = z.object({
  ig_business_account_id: z.string().min(3).max(40),
  fb_page_id: z.string().min(3).max(40).nullable().optional(),
  page_access_token: z.string().min(20),
});

export const getInstagramConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("instagram_connections")
      .select("id,ig_business_account_id,fb_page_id,username,followers_count,media_count,token_expires_at,created_at,updated_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

export const saveInstagramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => SaveSchema.parse(raw))
  .handler(async ({ data, context }) => {
    // Verify token by fetching IG account
    const verify = await fetch(
      `https://graph.facebook.com/v20.0/${data.ig_business_account_id}?fields=username,followers_count,media_count&access_token=${encodeURIComponent(data.page_access_token)}`,
    );
    const vjson = await verify.json();
    if (!verify.ok || vjson.error) {
      throw new Error(`Instagram verification failed: ${vjson.error?.message || `HTTP ${verify.status}`}`);
    }

    const row = {
      user_id: context.userId,
      ig_business_account_id: data.ig_business_account_id,
      fb_page_id: data.fb_page_id ?? null,
      page_access_token: data.page_access_token,
      username: vjson.username ?? null,
      followers_count: vjson.followers_count ?? 0,
      media_count: vjson.media_count ?? 0,
      updated_at: new Date().toISOString(),
    };
    const { data: saved, error } = await context.supabase
      .from("instagram_connections")
      .upsert(row as never, { onConflict: "user_id" })
      .select("id,username,followers_count,media_count")
      .single();
    if (error) throw new Error(error.message);
    return saved;
  });

export const disconnectInstagram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("instagram_connections")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const refreshInstagramStatsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { refreshInstagramStats } = await import("@/lib/instagram-upload.server");
    const data = await refreshInstagramStats(supabaseAdmin, context.userId);
    return data;
  });

const UploadSchema = z.object({ videoId: z.string().uuid() });

export const publishVideoToInstagram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => UploadSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { publishExistingVideoToInstagram } = await import("@/lib/instagram-upload.server");
    const result = await publishExistingVideoToInstagram({
      supabaseAdmin,
      userId: context.userId,
      videoId: data.videoId,
    });
    return { ok: true, ...result };
  });
