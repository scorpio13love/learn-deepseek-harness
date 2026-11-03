/** DeepSeek Messages 适配器：按真实 DSH 的 /v1/messages 协议实现。 */
export {
  DeepSeekError,
  DeepSeekModel,
  DeepSeekProvider,
  DeepSeekClient,
  createDeepSeekModel,
  createDeepSeekProvider,
  mapHttpError,
  mapUsage,
  mapFinishReason,
  toWireMessages,
  toWireTools,
} from './messages.ts'
