'use client';

import { useEffect, useRef } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { EdgeTraversedEvent } from '@fabritorio/types';
import { subscribeEdgeTraversals } from '@/lib/traversal-bus';

const PACKET_DURATION_MS = 900;
const SVG_NS = 'http://www.w3.org/2000/svg';

function packetColorClass(ev: EdgeTraversedEvent): string {
    return ev.portHint === 'error' ? 'fabritorio-packet--error' : 'fabritorio-packet--result';
}

export function FlowEdge(props: EdgeProps): React.ReactElement {
    const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
    const [edgePath] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });

    const layerRef = useRef<SVGGElement | null>(null);
    const pathRef = useRef(edgePath);
    pathRef.current = edgePath;

    useEffect(() => {
        const off = subscribeEdgeTraversals(id, (ev) => {
            const layer = layerRef.current;
            if (!layer) return;
            spawnPacket(layer, pathRef.current, ev);
        });
        return off;
    }, [id]);

    return (
        <>
            <BaseEdge
                id={id}
                path={edgePath}
                style={props.style}
                markerEnd={props.markerEnd}
                interactionWidth={props.interactionWidth}
            />
            {/* Packet layer — populated imperatively; never re-rendered by React. */}
            <g ref={layerRef} className="fabritorio-packet-layer" />
        </>
    );
}

function spawnPacket(layer: SVGGElement, path: string, ev: EdgeTraversedEvent): void {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', '4');
    circle.setAttribute('class', `fabritorio-packet ${packetColorClass(ev)}`);

    const motion = document.createElementNS(SVG_NS, 'animateMotion');
    motion.setAttribute('path', path);
    motion.setAttribute('dur', `${PACKET_DURATION_MS}ms`);
    motion.setAttribute('begin', '0s');
    motion.setAttribute('fill', 'freeze');
    motion.setAttribute('calcMode', 'linear');
    if (ev.direction === 'reverse') {
        motion.setAttribute('keyPoints', '1;0');
        motion.setAttribute('keyTimes', '0;1');
    }

    circle.appendChild(motion);
    layer.appendChild(circle);

    const remove = () => {
        if (circle.parentNode) circle.parentNode.removeChild(circle);
    };
    motion.addEventListener('endEvent', remove);
    window.setTimeout(remove, PACKET_DURATION_MS + 200);
}
