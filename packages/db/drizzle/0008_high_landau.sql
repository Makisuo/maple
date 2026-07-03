CREATE TABLE "org_billing_suspensions" (
	"org_id" text NOT NULL,
	"overdue_since" timestamp with time zone NOT NULL,
	"suspended_at" timestamp with time zone,
	"overdue_invoice_id" text,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_billing_suspensions_org_id_pk" PRIMARY KEY("org_id")
);
