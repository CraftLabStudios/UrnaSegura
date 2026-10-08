/**
 * Fila serial simples (mutex). Garante que dois votos simultâneos não recebam o mesmo
 * número de sequência na cadeia. O índice único (eleicaoId, seq) é a segunda barreira.
 * Em várias instâncias do servidor, troque por um lock distribuído.
 */
export class Fila {
  private cauda: Promise<unknown> = Promise.resolve();

  executar<T>(tarefa: () => Promise<T>): Promise<T> {
    const r = this.cauda.then(tarefa, tarefa);
    this.cauda = r.catch(() => undefined);
    return r;
  }
}
