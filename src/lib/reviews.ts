import { prisma } from "./prisma";
import { round2 } from "./utils";

/** Recalculate cached rating average/count from approved reviews. */
export async function recomputeRating(productId: string) {
  const agg = await prisma.review.aggregate({
    where: { productId, status: "APPROVED" },
    _avg: { rating: true },
    _count: { _all: true },
  });
  await prisma.product.update({
    where: { id: productId },
    data: { ratingAvg: round2(agg._avg.rating ?? 0), ratingCount: agg._count._all },
  });
}

export async function ratingSummary(productId: string) {
  const groups = await prisma.review.groupBy({
    by: ["rating"],
    where: { productId, status: "APPROVED" },
    _count: { _all: true },
  });
  const distribution = [5, 4, 3, 2, 1].map((r) => ({
    rating: r,
    count: groups.find((g) => g.rating === r)?._count._all ?? 0,
  }));
  const total = distribution.reduce((s, d) => s + d.count, 0);
  const avg = total ? distribution.reduce((s, d) => s + d.rating * d.count, 0) / total : 0;
  return { average: round2(avg), total, distribution };
}
