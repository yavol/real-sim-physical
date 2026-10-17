import { createHostedHandler } from '../web/handler.mjs';

export const config = { api: { bodyParser: false } };
export default createHostedHandler();
