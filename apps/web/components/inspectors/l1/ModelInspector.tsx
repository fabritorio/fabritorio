import type { ModelNode, Node } from '@fabritorio/types';
import { HeaderRow, Label, Input, TextArea, parseOptionalNumber } from '../shared';

export function ModelInspector({
    node,
    onChange,
}: {
    node: ModelNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    return (
        <div className="space-y-3">
            <HeaderRow label="Model" id={node.id} />
            <div>
                <Label>Provider</Label>
                <Input
                    value={node.provider}
                    onChange={(e) =>
                        onChange(node.id, { provider: e.target.value } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Model ID</Label>
                <Input
                    value={node.model_id}
                    onChange={(e) =>
                        onChange(node.id, { model_id: e.target.value } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Auth env var</Label>
                <Input
                    value={node.auth_env ?? ''}
                    placeholder="OPENAI_API_KEY"
                    onChange={(e) =>
                        onChange(node.id, {
                            auth_env: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div>
                <Label>Base URL (optional)</Label>
                <Input
                    value={node.base_url ?? ''}
                    placeholder="http://localhost:11434/v1"
                    onChange={(e) =>
                        onChange(node.id, {
                            base_url: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <Label>Temperature</Label>
                    <Input
                        type="number"
                        step="0.1"
                        value={node.temperature ?? ''}
                        onChange={(e) =>
                            onChange(node.id, {
                                temperature: parseOptionalNumber(e.target.value),
                            } as Partial<Node>)
                        }
                    />
                </div>
                <div>
                    <Label>Max tokens</Label>
                    <Input
                        type="number"
                        value={node.max_tokens ?? ''}
                        onChange={(e) =>
                            onChange(node.id, {
                                max_tokens: parseOptionalNumber(e.target.value),
                            } as Partial<Node>)
                        }
                    />
                </div>
            </div>
            <div>
                <Label>Reasoning</Label>
                <select
                    value={node.reasoning === undefined ? '' : node.reasoning ? 'on' : 'off'}
                    onChange={(e) => {
                        const v = e.target.value;
                        onChange(node.id, {
                            reasoning: v === '' ? undefined : v === 'on',
                        } as Partial<Node>);
                    }}
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                >
                    <option value="">Default (leave server default)</option>
                    <option value="on">On (request thinking)</option>
                    <option value="off">Off (suppress thinking)</option>
                </select>
            </div>
            <div>
                <Label>System prompt</Label>
                <TextArea
                    rows={5}
                    value={node.system_prompt ?? ''}
                    onChange={(e) =>
                        onChange(node.id, {
                            system_prompt: e.target.value || undefined,
                        } as Partial<Node>)
                    }
                />
            </div>
        </div>
    );
}
