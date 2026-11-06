CREATE TABLE `join_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "join_requests_email_lower_check" CHECK("join_requests"."email" = lower("join_requests"."email"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_requests_email_unique` ON `join_requests` (`email`);--> statement-breakpoint
CREATE INDEX `join_requests_created_idx` ON `join_requests` (`created_at`);