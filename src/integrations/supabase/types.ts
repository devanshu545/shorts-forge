export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      analytics_snapshots: {
        Row: {
          id: string
          metrics: Json
          snapshot_at: string
          source: string
          user_id: string
          video_id: string | null
        }
        Insert: {
          id?: string
          metrics: Json
          snapshot_at?: string
          source?: string
          user_id: string
          video_id?: string | null
        }
        Update: {
          id?: string
          metrics?: Json
          snapshot_at?: string
          source?: string
          user_id?: string
          video_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_snapshots_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "videos"
            referencedColumns: ["id"]
          },
        ]
      }
      autopilot_heartbeats: {
        Row: {
          detail: Json | null
          last_ping: string
          source: string
          updated_at: string
        }
        Insert: {
          detail?: Json | null
          last_ping?: string
          source: string
          updated_at?: string
        }
        Update: {
          detail?: Json | null
          last_ping?: string
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      autopilot_settings: {
        Row: {
          auto_pause_on_failures: boolean
          character_key: string
          characters_pool: string[]
          created_at: string
          enabled: boolean
          failure_streak: number
          hashtag_pool: string[]
          instagram_enabled: boolean
          niche: string | null
          pause_days: number[]
          privacy: string
          slot_hours: number[]
          slot_minutes: number[] | null
          slot_times: string[]
          style_preset: string
          timezone: string
          tone: string
          topic_mode: string
          updated_at: string
          user_id: string
          videos_per_day: number
          voice: string
          voices_pool: string[]
        }
        Insert: {
          auto_pause_on_failures?: boolean
          character_key?: string
          characters_pool?: string[]
          created_at?: string
          enabled?: boolean
          failure_streak?: number
          hashtag_pool?: string[]
          instagram_enabled?: boolean
          niche?: string | null
          pause_days?: number[]
          privacy?: string
          slot_hours?: number[]
          slot_minutes?: number[] | null
          slot_times?: string[]
          style_preset?: string
          timezone?: string
          tone?: string
          topic_mode?: string
          updated_at?: string
          user_id: string
          videos_per_day?: number
          voice?: string
          voices_pool?: string[]
        }
        Update: {
          auto_pause_on_failures?: boolean
          character_key?: string
          characters_pool?: string[]
          created_at?: string
          enabled?: boolean
          failure_streak?: number
          hashtag_pool?: string[]
          instagram_enabled?: boolean
          niche?: string | null
          pause_days?: number[]
          privacy?: string
          slot_hours?: number[]
          slot_minutes?: number[] | null
          slot_times?: string[]
          style_preset?: string
          timezone?: string
          tone?: string
          topic_mode?: string
          updated_at?: string
          user_id?: string
          videos_per_day?: number
          voice?: string
          voices_pool?: string[]
        }
        Relationships: []
      }
      instagram_connections: {
        Row: {
          created_at: string
          fb_page_id: string | null
          followers_count: number | null
          id: string
          ig_business_account_id: string
          media_count: number | null
          page_access_token: string
          token_expires_at: string | null
          updated_at: string
          user_id: string
          username: string | null
        }
        Insert: {
          created_at?: string
          fb_page_id?: string | null
          followers_count?: number | null
          id?: string
          ig_business_account_id: string
          media_count?: number | null
          page_access_token: string
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
          username?: string | null
        }
        Update: {
          created_at?: string
          fb_page_id?: string | null
          followers_count?: number | null
          id?: string
          ig_business_account_id?: string
          media_count?: number | null
          page_access_token?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
          username?: string | null
        }
        Relationships: []
      }
      long_video_events: {
        Row: {
          created_at: string
          detail: Json
          event_type: string
          id: string
          long_video_id: string
          message: string
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          event_type: string
          id?: string
          long_video_id: string
          message: string
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          event_type?: string
          id?: string
          long_video_id?: string
          message?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "long_video_events_long_video_id_fkey"
            columns: ["long_video_id"]
            isOneToOne: false
            referencedRelation: "long_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      long_videos: {
        Row: {
          attempt_count: number
          clip_length: number
          clips_generated: number
          completed_at: string | null
          created_at: string
          duration_seconds: number | null
          error_message: string | null
          failure_code: string | null
          id: string
          last_progress_at: string | null
          locked_at: string | null
          locked_by: string | null
          max_clips: number
          original_filename: string | null
          processing_started_at: string | null
          progress_percent: number
          progress_stage: string | null
          size_bytes: number | null
          source_path: string
          status: string
          updated_at: string
          upload_completed_at: string | null
          upload_started_at: string | null
          user_id: string
          worker_run_id: string | null
        }
        Insert: {
          attempt_count?: number
          clip_length?: number
          clips_generated?: number
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          failure_code?: string | null
          id?: string
          last_progress_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_clips?: number
          original_filename?: string | null
          processing_started_at?: string | null
          progress_percent?: number
          progress_stage?: string | null
          size_bytes?: number | null
          source_path: string
          status?: string
          updated_at?: string
          upload_completed_at?: string | null
          upload_started_at?: string | null
          user_id: string
          worker_run_id?: string | null
        }
        Update: {
          attempt_count?: number
          clip_length?: number
          clips_generated?: number
          completed_at?: string | null
          created_at?: string
          duration_seconds?: number | null
          error_message?: string | null
          failure_code?: string | null
          id?: string
          last_progress_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_clips?: number
          original_filename?: string | null
          processing_started_at?: string | null
          progress_percent?: number
          progress_stage?: string | null
          size_bytes?: number | null
          source_path?: string
          status?: string
          updated_at?: string
          upload_completed_at?: string | null
          upload_started_at?: string | null
          user_id?: string
          worker_run_id?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          message: string
          read: boolean
          title: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          read?: boolean
          title: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          read?: boolean
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      scheduled_jobs: {
        Row: {
          active: boolean
          auto_upload: boolean
          cadence: Database["public"]["Enums"]["cadence"]
          created_at: string
          duration_seconds: number
          hook_style: string | null
          id: string
          last_run_at: string | null
          name: string
          next_run_at: string
          niche: string
          tone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          auto_upload?: boolean
          cadence?: Database["public"]["Enums"]["cadence"]
          created_at?: string
          duration_seconds?: number
          hook_style?: string | null
          id?: string
          last_run_at?: string | null
          name: string
          next_run_at: string
          niche: string
          tone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          auto_upload?: boolean
          cadence?: Database["public"]["Enums"]["cadence"]
          created_at?: string
          duration_seconds?: number
          hook_style?: string | null
          id?: string
          last_run_at?: string | null
          name?: string
          next_run_at?: string
          niche?: string
          tone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      videos: {
        Row: {
          audio_url: string | null
          autopilot_slot: string | null
          clip_end_seconds: number | null
          clip_index: number | null
          clip_start_seconds: number | null
          created_at: string
          description: string | null
          duration_seconds: number | null
          error_message: string | null
          file_size_bytes: number | null
          generation_job_id: string | null
          generation_progress: number
          generation_stage: string | null
          hashtags: string[] | null
          id: string
          ig_caption: string | null
          ig_hashtags: string[] | null
          instagram_error: string | null
          instagram_media_id: string | null
          instagram_permalink: string | null
          last_progress_at: string | null
          long_video_id: string | null
          metadata_options: Json
          scheduled_for: string | null
          script: Json | null
          seo_keywords: string[] | null
          status: Database["public"]["Enums"]["video_status"]
          tags: string[]
          thumbnail_storage_path: string | null
          thumbnail_url: string | null
          title: string
          updated_at: string
          uploaded_at: string | null
          user_id: string
          video_storage_path: string | null
          video_url: string | null
          worker_run_id: string | null
          youtube_video_id: string | null
        }
        Insert: {
          audio_url?: string | null
          autopilot_slot?: string | null
          clip_end_seconds?: number | null
          clip_index?: number | null
          clip_start_seconds?: number | null
          created_at?: string
          description?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          file_size_bytes?: number | null
          generation_job_id?: string | null
          generation_progress?: number
          generation_stage?: string | null
          hashtags?: string[] | null
          id?: string
          ig_caption?: string | null
          ig_hashtags?: string[] | null
          instagram_error?: string | null
          instagram_media_id?: string | null
          instagram_permalink?: string | null
          last_progress_at?: string | null
          long_video_id?: string | null
          metadata_options?: Json
          scheduled_for?: string | null
          script?: Json | null
          seo_keywords?: string[] | null
          status?: Database["public"]["Enums"]["video_status"]
          tags?: string[]
          thumbnail_storage_path?: string | null
          thumbnail_url?: string | null
          title?: string
          updated_at?: string
          uploaded_at?: string | null
          user_id: string
          video_storage_path?: string | null
          video_url?: string | null
          worker_run_id?: string | null
          youtube_video_id?: string | null
        }
        Update: {
          audio_url?: string | null
          autopilot_slot?: string | null
          clip_end_seconds?: number | null
          clip_index?: number | null
          clip_start_seconds?: number | null
          created_at?: string
          description?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          file_size_bytes?: number | null
          generation_job_id?: string | null
          generation_progress?: number
          generation_stage?: string | null
          hashtags?: string[] | null
          id?: string
          ig_caption?: string | null
          ig_hashtags?: string[] | null
          instagram_error?: string | null
          instagram_media_id?: string | null
          instagram_permalink?: string | null
          last_progress_at?: string | null
          long_video_id?: string | null
          metadata_options?: Json
          scheduled_for?: string | null
          script?: Json | null
          seo_keywords?: string[] | null
          status?: Database["public"]["Enums"]["video_status"]
          tags?: string[]
          thumbnail_storage_path?: string | null
          thumbnail_url?: string | null
          title?: string
          updated_at?: string
          uploaded_at?: string | null
          user_id?: string
          video_storage_path?: string | null
          video_url?: string | null
          worker_run_id?: string | null
          youtube_video_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "videos_long_video_id_fkey"
            columns: ["long_video_id"]
            isOneToOne: false
            referencedRelation: "long_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      youtube_connections: {
        Row: {
          access_token: string
          analytics: Json
          channel_banner: string | null
          channel_created_at: string | null
          channel_description: string | null
          channel_id: string | null
          channel_thumbnail: string | null
          channel_title: string | null
          connected_at: string
          country: string | null
          made_for_kids: boolean | null
          refresh_token: string
          scope: string | null
          statistics: Json
          token_expires_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          analytics?: Json
          channel_banner?: string | null
          channel_created_at?: string | null
          channel_description?: string | null
          channel_id?: string | null
          channel_thumbnail?: string | null
          channel_title?: string | null
          connected_at?: string
          country?: string | null
          made_for_kids?: boolean | null
          refresh_token: string
          scope?: string | null
          statistics?: Json
          token_expires_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          analytics?: Json
          channel_banner?: string | null
          channel_created_at?: string | null
          channel_description?: string | null
          channel_id?: string | null
          channel_thumbnail?: string | null
          channel_title?: string | null
          connected_at?: string
          country?: string | null
          made_for_kids?: boolean | null
          refresh_token?: string
          scope?: string | null
          statistics?: Json
          token_expires_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      youtube_channel_info: {
        Row: {
          channel_id: string | null
          channel_thumbnail: string | null
          channel_title: string | null
          connected_at: string | null
          scope: string | null
          user_id: string | null
        }
        Insert: {
          channel_id?: string | null
          channel_thumbnail?: string | null
          channel_title?: string | null
          connected_at?: string | null
          scope?: string | null
          user_id?: string | null
        }
        Update: {
          channel_id?: string | null
          channel_thumbnail?: string | null
          channel_title?: string | null
          connected_at?: string | null
          scope?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      claim_next_long_video_job: {
        Args: {
          _explicit_id?: string
          _max_attempts?: number
          _stale_after?: string
          _worker_id: string
        }
        Returns: {
          attempt_count: number
          clip_length: number
          id: string
          max_clips: number
          source_path: string
          status: string
          user_id: string
        }[]
      }
      log_long_video_event: {
        Args: {
          _detail?: Json
          _event_type: string
          _long_video_id: string
          _message: string
          _user_id: string
        }
        Returns: undefined
      }
      mark_stale_long_video_jobs: {
        Args: { _max_attempts?: number; _stale_after?: string }
        Returns: number
      }
    }
    Enums: {
      cadence: "once" | "daily" | "weekly"
      video_status:
        | "draft"
        | "queued"
        | "scripting"
        | "generating_video"
        | "generating_audio"
        | "uploading"
        | "ready"
        | "failed"
        | "scheduled"
        | "published"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      cadence: ["once", "daily", "weekly"],
      video_status: [
        "draft",
        "queued",
        "scripting",
        "generating_video",
        "generating_audio",
        "uploading",
        "ready",
        "failed",
        "scheduled",
        "published",
      ],
    },
  },
} as const
