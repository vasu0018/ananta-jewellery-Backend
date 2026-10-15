import { Router } from "express";
import { requireAdmin } from "../../middleware/auth";
import authRoutes from "./auth";
import dashboardRoutes from "./dashboard";
import catalogRoutes from "./catalog";
import inventoryRoutes from "./inventory";
import orderRoutes from "./orders";
import shippingRoutes from "./shipping";
import paymentRoutes from "./payments";
import customerRoutes from "./customers";
import marketingRoutes from "./marketing";
import reportRoutes from "./reports";
import systemRoutes from "./system";

/** Everything under /api/v1/admin. Auth endpoints are public; the rest require an admin token. */
const router = Router();

router.use("/auth", authRoutes);
router.use(requireAdmin);
router.use(dashboardRoutes);
router.use(catalogRoutes);
router.use(inventoryRoutes);
router.use(orderRoutes);
router.use(shippingRoutes);
router.use(paymentRoutes);
router.use(customerRoutes);
router.use(marketingRoutes);
router.use(reportRoutes);
router.use(systemRoutes);

export default router;
