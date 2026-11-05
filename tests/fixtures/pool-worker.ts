export default {
  async fetch(): Promise<Response> {
    // The pool needs a Worker entry; these tests import route handlers directly.
    return new Response('not found', { status: 404 });
  },
};
