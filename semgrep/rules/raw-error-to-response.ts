app.post("/bad-route-1", async (request, reply) => {
  try {
    await doSomething();
  } catch (err) {
    // ruleid: raw-error-to-response
    reply.status(500).send(err);
  }
});

app.post("/bad-route-2", async (request, reply) => {
  try {
    await doSomething();
  } catch (error) {
    // ruleid: raw-error-to-response
    reply.status(500).send({ error: "InternalError", message: error.message });
  }
});

app.post("/bad-route-3", async (request, reply) => {
  try {
    await doSomething();
  } catch (e) {
    // ruleid: raw-error-to-response
    reply.send(e);
  }
});

app.post("/good-route-1", async (request, reply) => {
  try {
    await doSomething();
  } catch (err) {
    // ok: raw-error-to-response
    app.log.error(err);
    throw err;
  }
});

app.post("/good-route-2", async (request, reply) => {
  try {
    await doSomething();
  } catch (err) {
    // ok: raw-error-to-response
    reply.status(500).send({ error: "InternalError", message: "internal error" });
  }
});
