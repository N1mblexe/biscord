ALTER TABLE "users" ADD COLUMN "locale" varchar(5) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_ck" CHECK ("users"."locale" in ('en', 'tr'));