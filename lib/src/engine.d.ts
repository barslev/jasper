import { Observable } from 'rxjs';
import { Rule } from './rule';
import { EngineOptions } from './engine.option';
import { ExecutionResponse } from './execution.response';
export declare class JasperEngine {
    private contextStore;
    private ruleStore;
    private readonly options;
    private logger;
    constructor(ruleStore: Record<string, Rule>, options?: EngineOptions, logger?: Console);
    private executeAction;
    private processExpression;
    private processCompositeDependency;
    private processSimpleDependency;
    private execute;
    run(params: {
        root: any;
        ruleName: string;
    }): Observable<ExecutionResponse>;
}
