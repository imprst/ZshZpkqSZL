import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cancelHotelBookingHold } from "../../server/routes/hotelBookings.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  return cancelHotelBookingHold(req as never, res as never);
}
