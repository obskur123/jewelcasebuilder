CREATE TABLE "shares" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"scene" jsonb NOT NULL,
	"delete_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_textures" (
	"share_id" text NOT NULL,
	"key" text NOT NULL,
	"mime" text NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "share_textures_share_id_key_pk" PRIMARY KEY("share_id","key")
);
--> statement-breakpoint
ALTER TABLE "share_textures" ADD CONSTRAINT "share_textures_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;