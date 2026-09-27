import { getExchangeRates } from "../../server/routes/hotelBookings.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  return getExchangeRates(req as never, res as never);
}
