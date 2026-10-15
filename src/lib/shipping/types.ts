import type { Order, OrderItem, ShipmentStatus, ShippingPartner } from "@prisma/client";

export type PackageInfo = {
  weightGrams: number;
  length: number;
  width: number;
  height: number;
};

export type CreateShipmentRequest = {
  order: Order & { items: OrderItem[] };
  partner: ShippingPartner;
  pkg: PackageInfo;
  /** Manual AWB / courier (manual & India Post) */
  awb?: string;
  courierName?: string;
};

export type CreateShipmentResult = {
  awb: string;
  courierName: string;
  providerShipmentId?: string;
  labelUrl?: string;
  trackingUrl?: string;
  status?: ShipmentStatus;
};

export type TrackingEvent = {
  status: ShipmentStatus;
  location?: string;
  note?: string;
  occurredAt: Date;
};

export type TrackingResult = {
  status: ShipmentStatus;
  events: TrackingEvent[];
  ndrReason?: string;
};

export interface ShippingProvider {
  code: string;
  label: string;
  /** Fields the admin must fill in (rendered in Shipping Partners settings) */
  credentialFields: { key: string; label: string; secret?: boolean }[];
  createShipment(req: CreateShipmentRequest): Promise<CreateShipmentResult>;
  track(awb: string, partner: ShippingPartner): Promise<TrackingResult | null>;
  cancel?(awb: string, partner: ShippingPartner): Promise<void>;
  schedulePickup?(providerShipmentId: string, partner: ShippingPartner): Promise<void>;
  testConnection?(partner: ShippingPartner): Promise<string>;
}

/** Map free-text courier statuses to our enum. */
export function mapCourierStatus(text: string): ShipmentStatus {
  const s = text.toLowerCase();
  if (s.includes("rto") && s.includes("deliver")) return "RTO_DELIVERED";
  if (s.includes("rto") || s.includes("return to origin")) return "RTO_INITIATED";
  if (s.includes("out for delivery")) return "OUT_FOR_DELIVERY";
  if (s.includes("delivered")) return "DELIVERED";
  if (s.includes("undelivered") || s.includes("ndr") || s.includes("not delivered") || s.includes("failed")) return "NDR";
  if (s.includes("cancel")) return "CANCELLED";
  if (s.includes("picked")) return "PICKED_UP";
  if (s.includes("pickup") || s.includes("manifest")) return "PICKUP_SCHEDULED";
  if (s.includes("transit") || s.includes("shipped") || s.includes("dispatch") || s.includes("reached")) return "IN_TRANSIT";
  return "IN_TRANSIT";
}
