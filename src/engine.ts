import { Observable, empty, of, from, forkJoin, throwError, concat, defer } from 'rxjs';
import { switchMap, tap, toArray, share, catchError, shareReplay, map, mapTo } from 'rxjs/operators';
import jsonata from 'jsonata';
import hash from 'object-hash';
import _ from 'lodash';
import {
    ExecutionResponse,
    CompositeDependencyExecutionResponse,
    SimpleDependencyExecutionResponse,
} from './execution.response';
import moment from 'moment';
import { ExecutionContext } from './execution.context';
import { JasperRule } from './jasper.rule';
import { DefaultEngineOptions, EngineOptions } from './engine.option';
import { isSimpleDependency, SimpleDependency } from './simple.dependency';
import { ExecutionOrder, Operator } from './enum';
import { CompositeDependency, isCompositeDependency } from './composite.dependency';

export class JasperEngine {
    private contextStore: Record<string, ExecutionContext>;
    private ruleStore: Record<string, JasperRule>;
    private readonly options: EngineOptions;
    private logger: any;

    /**
     * 
     * @param ruleStore a dictionary of all rules
     * @param options options
     * @param logger logger
     */
    constructor(ruleStore: Record<string, JasperRule>, options: EngineOptions = DefaultEngineOptions, logger = console) {
        this.options = options;
        this.contextStore = {};
        this.ruleStore = ruleStore;
        this.logger = logger;
    }

    /**
     * execute the rule action
     * @param params 
     * @param params.action action to run
     * @param params.context the execution context
     * 
     * @example jsonata expression
     * executeAction('jsonataExpression', context)
     * 
     * @example observable
     * executeAction(of(1), context)
     * 
     * @example async function 
     * executeAction(async (context) => {}, context)
     * 
     * @example function 
     * executeAction((context) => {}, context)
     */
    private executeAction(params: {
        action: string | Observable<unknown> | ((context: ExecutionContext) => Observable<any>),
        context: ExecutionContext,
    }): Observable<any> {
        if (typeof params.action === 'string' || params.action instanceof String) {
            const expression = jsonata(params.action as string);
            return of(expression.evaluate(params.context.root));
        }

        if (params.action instanceof Observable) {
            return from(params.action);
        }

        if (params.action instanceof Function) {
            return (params.action(params.context) as Observable<any>);
        }

        return of(null);
    }

    /**
     * Process the path expression|function|observable
     * @param path the path expression | function | observable
     * @param context
     *
     * @example
     * processExpression('jsonataExpression', context);
     *
     * @example
     * processExpression((context) => {} , context);
     *
     * @example
     * processExpression(async (context) => {} , context);
     *
     * @example
     * processExpression(of(true), context);
     */
    private processExpression(
        expression: string | ((context: ExecutionContext) => Observable<any>),
        context: ExecutionContext
    ): Observable<any[]> {
        if (typeof expression === 'string') {
            const jsonataExpression = jsonata(expression as string);
            const expressionObject = jsonataExpression.evaluate(context.root);
            return of(expressionObject).pipe(
                toArray(),
                map((arr) => {
                    return _.chain(_.flatten(arr))
                        .filter((expressionObject) => expressionObject)
                        .value();
                })
            );
        }

        if (expression instanceof Function) {
            return expression(context).pipe(
                toArray(),
                map((arr) => {
                    return _.chain(_.flatten(arr))
                        .filter((expressionObject) => expressionObject)
                        .value();
                })
            );
        }

        return of([]);
    }

    /**
     * Process a simple dependency
     * it will execute the path expression and for each match schedule an observables and add to the accumulator
     * @param accumulator a dictionary of tasks
     * @param compositeDependency the compound dependency object
     * @param context the current execution context
     */
    private processSimpleDependency(
        accumulator: Record<string, Observable<any>>,
        simpleDependency: SimpleDependency,
        context: ExecutionContext
    ): void {
        const registerMatchesHandler = this.processExpression(simpleDependency.path, context).subscribe(
            (pathObjects: any[]) => {
                _.each(pathObjects, (pathObject, index) => {
                    const simpleDependencyResponse: SimpleDependencyExecutionResponse = {
                        name: `${simpleDependency.name}`,
                        isSkipped: false,
                        rule: simpleDependency.rule,
                        hasError: false,
                        isSuccessful: false,
                        result: null,
                        index,
                    };

                    const task = of(pathObject).pipe(
                        switchMap((pathObject: any) => {
                            simpleDependencyResponse.startDateTime = moment.utc().toDate();
                            return this.execute({
                                root: pathObject,
                                ruleName: simpleDependency.rule,
                                parentExecutionContext: context,
                            });
                        }),
                        switchMap((r: ExecutionResponse) => {
                            simpleDependencyResponse.result = r.result;
                            simpleDependencyResponse.isSuccessful = r.isSuccessful;
                            simpleDependencyResponse.dependency = r.dependency;
                            simpleDependencyResponse.startDateTime = r.startDateTime;
                            simpleDependencyResponse.completedTime = r.completedTime;
                            /* istanbul ignore next */
                            if (this.options.debug) {
                                simpleDependencyResponse.debugContext = r.debugContext;
                                
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                                simpleDependencyResponse.debugContext!.executionOrder = simpleDependency.executionOrder || ExecutionOrder.Parallel;
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                                simpleDependencyResponse.debugContext!.whenDescription = simpleDependency.whenDescription;
                            }
                            return of(simpleDependencyResponse);
                        }),
                        catchError((err) => {
                            simpleDependencyResponse.error = err;
                            simpleDependencyResponse.hasError = true;
                            simpleDependencyResponse.isSuccessful = false;
                            simpleDependencyResponse.completedTime = moment.utc().toDate();
                            return of(simpleDependencyResponse);
                        })
                    );

                    accumulator[`${simpleDependency.name}-${index}`] = task;
                });
            },
            (err) => {
                const errReponse: SimpleDependencyExecutionResponse = {
                    name: `${simpleDependency.name}`,
                    isSkipped: false,
                    rule: simpleDependency.rule,
                    debugContext: undefined,
                    error: err,
                    hasError: true,
                    isSuccessful: false,
                    result: null,
                };
                accumulator[`${simpleDependency.name}`] = of(errReponse);
            },
        );

        registerMatchesHandler.unsubscribe();
    }

    /**
     * 
     * @param accumulator a dictionary of tasks 
     * @param simpleDependency the simple dependency object
     * @param context the current execution context
     */
    private extractSimpleDependencyTasks(
        accumulator: Record<string, Observable<SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse>>,
        simpleDependency: SimpleDependency,
        context: ExecutionContext,
    ) {
        // process when clause
        const whenSubscription = defer(() => {
            return simpleDependency.when ? this.processExpression(simpleDependency.when, context).pipe(
                switchMap(r => {
                    return of(_.get(r, '[0]', false));
                }),
            ) : of(true);
        }).subscribe({
            next: (x: boolean) => {
                if (x) {
                    this.processSimpleDependency(accumulator, simpleDependency, context);
                } else {
                    const skipped: SimpleDependencyExecutionResponse = {
                        name: `${simpleDependency.name}`,
                        isSkipped: true,
                        rule: simpleDependency.rule,
                        hasError: false,
                        isSuccessful: true,
                        result: null,
                    };
                    /* istanbul ignore next */
                    if (this.options.debug) {
                        skipped.debugContext = {
                            root: context.root,
                            whenDescription: simpleDependency.whenDescription,
                        };
                    }
                    accumulator[`${simpleDependency.name}`] = of(skipped);
                }
            },
            error: (err) => {
                const errorResponse: SimpleDependencyExecutionResponse = {
                    name: `${simpleDependency.name}`,
                    isSkipped: true,
                    rule: simpleDependency.rule,
                    error: err,
                    debugContext: undefined,
                    hasError: true,
                    isSuccessful: false,
                    result: null,
                };
                accumulator[`${simpleDependency.name}`] = of(errorResponse);
            }
        });

        whenSubscription.unsubscribe();
    }

    private extractCompositeDependencyTasks(
        accumulator: Record<string, Observable<SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse>>,
        compositeDependency: CompositeDependency,
        context: ExecutionContext,
    ) {
        const compositeDependencyResponse: CompositeDependencyExecutionResponse = {
            name: compositeDependency.name,
            hasError: false,
            isSuccessful: false,
            isSkipped: false,
            rules: [],
        };

        const whenSubscription = defer(() => {
            return compositeDependency.when ? this.processExpression(compositeDependency.when, context).pipe(
                switchMap(r => {
                    return of(_.get(r, '[0]', false));
                }),
            ) : of(true);
        }).subscribe({
            next: (when: boolean) => {
                if (when) {
                    accumulator[compositeDependency.name] = of(true).pipe(
                        switchMap(() => {
                            compositeDependencyResponse.startDateTime = moment.utc().toDate();
                            return this.processCompositeDependency(compositeDependency, context);
                        }),
                        switchMap((r: CompositeDependencyExecutionResponse) => {
                            compositeDependencyResponse.isSuccessful = r.isSuccessful;
                            compositeDependencyResponse.hasError = r.hasError;
                            compositeDependencyResponse.error = r.error;
                            compositeDependencyResponse.rules = r.rules;
                            compositeDependencyResponse.completedTime = r.completedTime;
                            /* istanbul ignore next */
                            if (this.options.debug) {
                                compositeDependencyResponse.debugContext = r.debugContext;
                            }

                            return of(compositeDependencyResponse);
                        })
                    );
                } else {
                    compositeDependencyResponse.isSkipped = true;
                    compositeDependencyResponse.isSuccessful = true;

                    /* istanbul ignore next */
                    if (this.options.debug) {
                        compositeDependencyResponse.debugContext = {
                            root: context.root,
                            whenDescription: compositeDependency.whenDescription,
                        };
                    }
                    accumulator[`${compositeDependency.name}`] = of(compositeDependencyResponse);
                }
            },
            error: (err) => {
                compositeDependencyResponse.hasError = true;
                compositeDependencyResponse.error = err;
                accumulator[`${compositeDependency.name}`] = of(compositeDependencyResponse);
            }
        });

        whenSubscription.unsubscribe();
    }

    /**
     * 
     * @param compositeDependency 
     * @param context 
     */
    private collectDependencyTasks(
        compositeDependency: CompositeDependency,
        context: ExecutionContext
    ): Record<string, Observable<SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse>> {
        const tasks: Record<
            string,
            Observable<SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse>
        > = _.reduce(
            compositeDependency.rules,
            (accumulator: Record<string, Observable<any>>, rule) => {
                if (isSimpleDependency(rule)) {
                    this.extractSimpleDependencyTasks(accumulator, rule as SimpleDependency, context);
                } 
                /* istanbul ignore else  */
                else if (isCompositeDependency(rule)) {
                    this.extractCompositeDependencyTasks(accumulator, rule as CompositeDependency, context);
                }
                return accumulator;
            },
            {}
        );

        return tasks;
    }

    /**
     * Process a compound dependency
     * @param compositeDependency the compound dependency object
     * @param context the current execution context
     */
    private processCompositeDependency(
        compositeDependency: CompositeDependency,
        context: ExecutionContext
    ): Observable<CompositeDependencyExecutionResponse> {
        const operator = compositeDependency.operator || Operator.AND;
        const executionOrder = compositeDependency.executionOrder || ExecutionOrder.Parallel;

        const response: CompositeDependencyExecutionResponse = {
            name: compositeDependency.name,
            hasError: false,
            isSkipped: false,
            isSuccessful: false,
            rules: [],
            startDateTime: moment.utc().toDate(),
        };

        /* istanbul ignore next */
        if (this.options.debug) {
            response.debugContext = {
                root: context.root,
                executionOrder,
                operator,
            }
        }

        const tasks = this.collectDependencyTasks(compositeDependency, context);

        const values = _.values(tasks);
        // let counter = 0;

        const runTask: Observable<(SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse)[]> =
            executionOrder === ExecutionOrder.Parallel
                ? forkJoin(tasks).pipe(
                      map(
                          (
                              results: Record<
                                  string,
                                  SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse
                              >
                          ) => {
                              const entries = _.entries(results).map(([, result]) => result);
                              response.rules = _.map(
                                  entries,
                                  (result: SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse) =>
                                      result
                              );

                              return entries;
                          }
                      )
                  )
                : concat(...values).pipe(
                      tap((result) => {
                          response.rules.push(result);
                          // counter ++;
                      }),
                      toArray()
                  );

        return runTask.pipe(
            switchMap((results: (SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse)[]) => {
                response.completedTime = moment.utc().toDate();
                response.isSuccessful =
                    operator === Operator.AND
                        ? _.every(
                              results,
                              (result: SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse) =>
                                  result.isSuccessful
                          )
                        : _.some(
                              results,
                              (result: SimpleDependencyExecutionResponse | CompositeDependencyExecutionResponse) =>
                                  result.isSuccessful
                          );
                response.hasError = !response.isSuccessful;
                return of(response);
            })
        );
    }

    /**
     * execute the root object against a rule
     * @param params
     * @param params.root the object to evaluate
     * @param params.ruleName the rule name to evaluate against
     * @param params.parentExecutionContext [parent execution context] the parent context of current context
     */
    private execute(params: {
        root: any;
        ruleName: string;
        parentExecutionContext?: ExecutionContext;
    }): Observable<ExecutionResponse> {
        const rule: JasperRule = this.ruleStore[params.ruleName];

        const ruleHash = hash(params.ruleName);
        const objectHash = hash(params.root);
        const contextHash = ruleHash + objectHash;
        const contextId = `${contextHash}${ this.options.suppressDuplicateTasks ? '' : _.uniqueId('-')}`;
        let context: ExecutionContext = this.contextStore[contextId];

        if (!context || this.options.suppressDuplicateTasks === false) {
            context = {
                contextId,
                rule,
                root: params.root,
                _process$: empty(),
                complete: false,
                contextData: {},
            };

            if (this.options.debug) {
                context.contextData.objectHash = objectHash;
            }

            this.contextStore[contextId] = context;
            if (params.parentExecutionContext) {
                context.parentContext = params.parentExecutionContext;
                (params.parentExecutionContext.childrenContexts = params.parentExecutionContext.childrenContexts || {})[
                    context.contextId
                ] = context;
            }
        } else {
            return context._process$;
        }

        const response: ExecutionResponse = {
            rule: params.ruleName,
            hasError: false,
            isSuccessful: false,
            result: undefined,
            debugContext: this.options.debug ? 
            {
                contextId,
                root: context.root,
                ruleName: rule.name,
            } : undefined,
        };

        context._process$ = of(true).pipe(
            // call beforeAction
            switchMap((x) => {
                response.startDateTime = moment.utc().toDate();
                if (rule.beforeAction) {
                    return rule.beforeAction(context).pipe(
                        tap(() => {
                            /* istanbul ignore next */
                            if (this.options.debug) {
                                this.logger.debug(`before action executed for rule ${rule.name} - context ${context.contextId}`);
                            }
                        }),
                    );
                }
                return of(x);
            }),
            // execute the main action
            switchMap(() => {
                return this.executeAction({
                    action: rule.action,
                    context,
                });
            }),
            catchError((err) => {
                response.isSuccessful = false;
                response.hasError = true;
                response.error = err;
                response.completedTime = moment.utc().toDate();
                if (rule.onError) {
                    /* if a custom onError handler is specified
                       let it decide if we should replace the the stream 
                       or let it fail
                    */ 
                    return rule.onError(err, context).pipe(
                        tap(() => {
                            /* istanbul ignore next */
                            if (this.options.debug) {
                                this.logger.debug(`onError executed for rule ${rule.name} - context ${context.contextId}`);
                            }
                        }),
                    );
                }

                return throwError(err);
            }),
            tap((result) => {
                context.complete = true;
                response.isSuccessful = true;
                response.result = result;
                response.completedTime = moment.utc().toDate();
            }),
            // call dependency rules
            switchMap(() => {
                if (rule.dependencies && rule.dependencies.rules && rule.dependencies.rules.length) {
                    return this.processCompositeDependency(rule.dependencies, context).pipe(
                        tap((dependencyReponse) => {
                            response.dependency = dependencyReponse;
                        }),
                        mapTo(response),
                    );
                }
                return of(response);
            }),
            // call afterAction
            switchMap((response) => {
                if (rule.afterAction) {
                    return rule.afterAction(response, context).pipe(
                        tap(() => {
                            /* istanbul ignore next */
                            if (this.options.debug) {
                                this.logger.debug(`after action executed for rule ${rule.name} - context ${context.contextId}`);
                            }
                        }),
                    );
                }
                return of(response);
            })
        );

        if (this.options.suppressDuplicateTasks) {
            context._process$ = context._process$.pipe(shareReplay(1));
        } else {
            context._process$ = context._process$.pipe(share());
        }

        return context._process$;
    }

    /* istanbul ignore next */
    /**
     * @param params
     * @param params.root the object to evaluate
     * @param params.ruleName the rule name to evaluate against
     */
    run(params: { root: any; ruleName: string }): Observable<ExecutionResponse> {
        return this.execute({ root: params.root, ruleName: params.ruleName });
    }
}
