import type { Node, SecretBinding, SecretsNode } from '@fabritorio/types';
import { HeaderRow, Label, Input } from '../shared';

export function SecretsInspector({
    node,
    onChange,
}: {
    node: SecretsNode;
    onChange: (id: string, patch: Partial<Node>) => void;
}) {
    const bindings: SecretBinding[] = node.bindings ?? [];
    const setBindings = (next: SecretBinding[]) => {
        onChange(node.id, { bindings: next } as Partial<Node>);
    };
    const updateRow = (idx: number, patch: Partial<SecretBinding>) => {
        setBindings(bindings.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
    };
    const addRow = () => {
        setBindings([...bindings, { name: '', source: '' }]);
    };
    const removeRow = (idx: number) => {
        setBindings(bindings.filter((_, i) => i !== idx));
    };
    return (
        <div className="space-y-3">
            <HeaderRow label="Secrets" id={node.id} />
            <p className="text-[10px] text-zinc-500 dark:text-zinc-500">
                Names + sources only — values live in <code>~/.fabritorio/secrets.env</code>, never
                in the graph. Wire <code>secrets → tool</code>; the wire is the grant.
            </p>
            <div className="space-y-2">
                {bindings.length === 0 && (
                    <p className="text-[10px] text-zinc-400 dark:text-zinc-600">No keys yet.</p>
                )}
                {bindings.map((b, idx) => (
                    <div
                        // eslint-disable-next-line react/no-array-index-key -- rows are positional; bindings carry no stable id
                        key={idx}
                        className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
                    >
                        <div className="mb-1.5">
                            <Label>Name</Label>
                            <Input
                                value={b.name}
                                placeholder="STRIPE_SECRET_KEY"
                                onChange={(e) => updateRow(idx, { name: e.target.value })}
                            />
                        </div>
                        <div>
                            <Label>Source</Label>
                            <Input
                                value={b.source}
                                placeholder={
                                    b.name.length > 0 ? `env:${b.name} (default)` : 'env:NAME'
                                }
                                onChange={(e) => updateRow(idx, { source: e.target.value })}
                            />
                        </div>
                        <button
                            type="button"
                            onClick={() => removeRow(idx)}
                            className="mt-1.5 text-[10px] text-rose-600 hover:underline dark:text-rose-400"
                        >
                            Remove
                        </button>
                    </div>
                ))}
            </div>
            <button
                type="button"
                onClick={addRow}
                className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
                + Add key
            </button>
        </div>
    );
}
