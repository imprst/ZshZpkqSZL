import { cancelHotelBookingPayment } from "../../../server/routes/hotelBookings.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  return cancelHotelBookingPayment(req as never, res as never);
}
