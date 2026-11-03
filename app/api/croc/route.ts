import { crocOptions, crocPost } from '../../../src/croc';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const OPTIONS = (req: Request) => crocOptions(req);
export const POST = (req: Request) => crocPost(req);
