import { GraphRoute } from '@/components/GraphRoute';

interface Props {
    params: Promise<{ id: string }>;
}

export const dynamicParams = false;
export function generateStaticParams(): { id: string }[] {
    return [{ id: '_' }];
}

export default async function GraphPage({ params }: Props) {
    const { id } = await params;
    return <GraphRoute id={id} />;
}
