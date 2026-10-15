-- CreateTable
CREATE TABLE "DailyTraffic" (
    "date" DATE NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "productViews" INTEGER NOT NULL DEFAULT 0,
    "addToCarts" INTEGER NOT NULL DEFAULT 0,
    "checkouts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyTraffic_pkey" PRIMARY KEY ("date")
);
