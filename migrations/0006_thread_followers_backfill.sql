-- R-NTF-07: threads that predate `thread_followers` are followed by their author and every
-- commenter (a deleted comment still counts: deleting never unfollows).
INSERT OR IGNORE INTO `thread_followers` (`post_id`, `user_id`) SELECT `id`, `author_id` FROM `posts`;--> statement-breakpoint
INSERT OR IGNORE INTO `thread_followers` (`post_id`, `user_id`) SELECT `post_id`, `author_id` FROM `comments`;
