CREATE INDEX `albums_name_idx` ON `albums` (`name`,`id`);--> statement-breakpoint
CREATE INDEX `info_pages_order_idx` ON `info_pages` ("is_pinned" desc,`sort_order`,`title`,`id`);--> statement-breakpoint
CREATE INDEX `users_role_status_idx` ON `users` (`role`,`status`);