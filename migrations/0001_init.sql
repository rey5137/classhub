CREATE TABLE `albums` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`year_tag` integer,
	`description` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `audit_events_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`object_count` integer NOT NULL,
	`total_bytes` integer NOT NULL,
	`verified_at` integer,
	`reported_at` integer
);
--> statement-breakpoint
CREATE TABLE `chat_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`range_start` integer NOT NULL,
	`range_end` integer NOT NULL,
	`record_count` integer NOT NULL,
	`sha256` text NOT NULL,
	`exported_at` integer NOT NULL,
	`verified_at` integer,
	`purged_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_archives_file_name_unique` ON `chat_archives` (`file_name`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`client_nonce` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_sender_nonce_unique` ON `chat_messages` (`sender_id`,`client_nonce`);--> statement-breakpoint
CREATE INDEX `chat_messages_room_idx` ON `chat_messages` (`room_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `chat_messages_created_idx` ON `chat_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body_md` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `comments_post_idx` ON `comments` (`post_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `info_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `info_pages_slug_unique` ON `info_pages` (`slug`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`invited_by` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`access_synced_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_email_unique` ON `invites` (`email`);--> statement-breakpoint
CREATE INDEX `invites_status_email_idx` ON `invites` (`status`,`email`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`album_id` text,
	`media_type` text NOT NULL,
	`object_key` text NOT NULL,
	`thumb_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`thumb_size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`thumb_sha256` text NOT NULL,
	`caption` text,
	`taken_year` integer,
	`effective_year` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`purged_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "media_media_type_check" CHECK("media"."media_type" in ('photo', 'avatar', 'site'))
);
--> statement-breakpoint
CREATE INDEX `media_album_idx` ON `media` (`album_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `media_owner_idx` ON `media` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_effective_year_idx` ON `media` (`effective_year`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `media_deleted_purged_idx` ON `media` (`deleted_at`,`purged_at`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`is_locked` integer DEFAULT false NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `posts_pinned_activity_idx` ON `posts` ("is_pinned" desc,"last_activity_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `posts_activity_idx` ON `posts` ("last_activity_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `profile_contacts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`contact_email` text,
	`phone` text,
	`messaging_url` text,
	`city` text,
	`bio` text,
	`visibility_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rate_events` (
	`bucket` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_events_bucket_idx` ON `rate_events` (`bucket`,`at`);--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `storage_usage` (
	`singleton_id` integer PRIMARY KEY NOT NULL,
	`committed_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`last_reconciled_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "storage_usage_singleton_id_check" CHECK("storage_usage"."singleton_id" = 1)
);
--> statement-breakpoint
CREATE TABLE `upload_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`media_id` text,
	`purpose` text NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`image_bytes` integer NOT NULL,
	`thumb_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`thumb_sha256` text NOT NULL,
	`mime_type` text NOT NULL,
	`object_key` text NOT NULL,
	`thumb_key` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`state_run_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "upload_reservations_state_check" CHECK("upload_reservations"."state" in ('open', 'completed', 'released'))
);
--> statement-breakpoint
CREATE INDEX `upload_reservations_state_idx` ON `upload_reservations` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `upload_reservations_state_run_idx` ON `upload_reservations` (`state_run_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_email` text NOT NULL,
	`access_sub` text,
	`display_name` text NOT NULL,
	`display_name_norm` text NOT NULL,
	`preferred_name` text,
	`preferred_name_norm` text,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`avatar_media_id` text,
	`deletion_requested_at` integer,
	`deletion_keep_content` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_email_unique` ON `users` (`auth_email`);--> statement-breakpoint
CREATE INDEX `users_status_display_name_norm_idx` ON `users` (`status`,`display_name_norm`);--> statement-breakpoint
CREATE INDEX `users_status_preferred_name_norm_idx` ON `users` (`status`,`preferred_name_norm`);--> statement-breakpoint
INSERT INTO `schema_meta` (`key`, `value`) VALUES ('schema_version', '1');--> statement-breakpoint
INSERT INTO `schema_meta` (`key`, `value`) VALUES ('housekeeping_last_run_at', '0');
