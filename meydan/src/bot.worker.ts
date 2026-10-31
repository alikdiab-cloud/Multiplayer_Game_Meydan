import { createBotWorkerResponse } from "../shared/botWorkerHandler.js";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const response = createBotWorkerResponse(event.data);
  if (response !== null) {
    workerScope.postMessage(response);
  }
});
