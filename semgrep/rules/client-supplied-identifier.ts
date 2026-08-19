app.post("/bad-route-1", async (request, reply) => {
  // ruleid: client-supplied-identifier
  const { account_id } = request.body as { account_id: string };
  const account = await db.selectFrom("accounts").where("account_id", "=", account_id).executeTakeFirst();
});

app.get("/bad-route-2", async (request, reply) => {
  // ruleid: client-supplied-identifier
  const userId = request.params.user_id;
});

app.post("/bad-route-3", async (request, reply) => {
  // ruleid: client-supplied-identifier
  const { user_id, amount } = request.body as { user_id: string; amount: string };
});

app.get("/good-route", async (request, reply) => {
  // ok: client-supplied-identifier
  const { aid: accountId, sub: userId } = request.user;
  const { rib } = request.params as { rib: string };
});
