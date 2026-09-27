import { verifyHotelBookingPayment } from "../../../server/routes/hotelBookings.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  return verifyHotelBookingPayment(req as never, res as never);
}
