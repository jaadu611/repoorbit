import { sectionData } from "@/constants/landingPage.constants";
import {
  Atom,
  GitBranch,
  icons,
  LockOpen,
  LucideIcon,
  LucideLayers,
  Network,
  TreePine,
} from "lucide-react";

const Page = () => {
  return (
    <div className="w-full bg-gray-900">
      <div className="relative w-full px-6 py-20 md:py-24 overflow-hidden flex items-center">
        {/* Background Grids */}
        <div
          className="absolute inset-0 z-0"
          style={{
            backgroundImage: `linear-gradient(to right, rgba(59, 130, 246, 0.2) 2px, transparent 2px),linear-gradient(to bottom, rgba(59, 130, 246, 0.2) 2px, transparent 2px)`,
            backgroundSize: "60px 60px",
          }}
        />
        <div className="absolute inset-0 z-0 bg-linear-to-b from-gray-900 via-transparent to-gray-900" />
        <div className="absolute inset-0 z-0 bg-linear-to-r from-gray-900 via-transparent to-gray-900" />

        {/* Hero Content */}
        <section className="relative z-10 w-full max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-12 lg:gap-16">
          {/* left */}
          <div className="flex flex-col items-center md:items-start flex-1 text-center md:text-left">
            <h1 className="text-gray-100 text-5xl lg:text-6xl xl:text-7xl font-black tracking-tighter leading-none md:leading-[0.95]">
              Visualize your <br />
              <span className="text-blue-500">Codebase DNA.</span>
            </h1>

            <p className="text-base md:text-lg text-gray-400 max-w-xl mt-6 leading-relaxed font-medium">
              Tired of the mess your intern made or just your old self? Stop
              snooping around scattered files at 3am. RepoOrbit turns your mess
              of a codebase into a visual map so you don't go insane
            </p>

            {/* Bottom stuff */}
            <div className="mt-10 flex flex-wrap items-center justify-center md:justify-start gap-2 md:gap-4 border-t border-gray-800/60 pt-8 w-full">
              <div className="flex items-center gap-2 border-2 border-gray-600 px-3 py-2 rounded-full">
                <LockOpen
                  size={14}
                  className="text-blue-500"
                  strokeWidth={2.5}
                />
                <span className="text-gray-400 pt-1 font-mono text-[10px] font-bold uppercase tracking-wider">
                  No Login Required
                </span>
              </div>

              <div className="flex items-center gap-2 border-2 border-gray-600 px-3 py-2 rounded-full">
                <GitBranch
                  size={14}
                  className="text-blue-500"
                  strokeWidth={2.5}
                />
                <span className="text-gray-400 pt-1 font-mono text-[10px] font-bold uppercase tracking-wider">
                  MIT Open Source
                </span>
              </div>

              <div className="flex items-center gap-2 border-2 border-gray-600 px-3 py-2 rounded-full">
                <Atom size={14} className="text-blue-500" strokeWidth={2.5} />
                <span className="text-gray-400 pt-1 font-mono text-[10px] font-bold uppercase tracking-wider">
                  Instant Visualization
                </span>
              </div>
            </div>
          </div>

          {/* right */}
          <div className="flex-1 w-full max-w-xl lg:max-w-2xl">
            <div className="rounded-2xl border border-gray-700 bg-gray-800/40 p-3 backdrop-blur-xl shadow-2xl">
              <div className="rounded-lg overflow-hidden">
                <img
                  className="w-full h-auto opacity-90"
                  src="https://assets.prebuiltui.com/images/components/hero-section/hero-rightsocial-image.png"
                  alt="Visualization Interface"
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* sections */}
      {sectionData.map(
        ({
          id,
          Icon,
          badgeText,
          title,
          highlightTitle,
          description,
          imageSrc,
        }: {
          id: number;
          Icon: LucideIcon;
          badgeText: string;
          title: string;
          highlightTitle: string;
          description: string;
          imageSrc: string;
        }) => (
          <section
            key={id}
            className={`relative z-10 w-full max-w-7xl mx-auto px-6 py-24 flex flex-col-reverse ${id % 2 !== 0 ? "md:flex-row" : "md:flex-row-reverse"} items-center justify-between gap-12 lg:gap-24 border-t-2 border-gray-800`}
          >
            <div className="flex-1 w-full max-w-xl lg:max-w-2xl group">
              <div className="relative">
                <div className="relative rounded-2xl border border-gray-700 bg-gray-800/40 p-3 backdrop-blur-xl shadow-2xl">
                  {/* placeholder */}
                  <img
                    className="w-full h-auto opacity-90"
                    src={imageSrc}
                    alt="Section Visualization"
                  />
                </div>
              </div>
            </div>

            <div
              className={`flex flex-col items-center ${id % 2 !== 0 ? "md:items-end md:text-right" : "md:items-start md:text-left"} flex-1 text-center`}
            >
              <div className="flex items-center gap-2 border-2 border-gray-600 px-3 py-2 rounded-full">
                <Icon size={14} className="text-blue-500" strokeWidth={2.5} />
                <span className="text-gray-400 pt-1 font-mono text-[10px] font-bold uppercase tracking-wider">
                  {badgeText}
                </span>
              </div>

              <h2 className="text-gray-100 mt-6 text-4xl lg:text-5xl font-black tracking-tight">
                {title} <br />
                <span className="text-blue-500">{highlightTitle}</span>
              </h2>

              <p className="text-base md:text-lg text-gray-400 max-w-xl mt-6 leading-relaxed font-medium">
                {description}
              </p>
            </div>
          </section>
        ),
      )}

      {/* final section befoore footer */}
      <section className="relative z-10 w-full max-w-7xl mx-auto px-6 py-24 flex flex-col items-center text-center border-t-2 border-gray-800">
        <div className="flex flex-col items-center max-w-4xl">
          <h2 className="text-gray-100 text-5xl md:text-8xl font-black tracking-tighter">
            Stop reading code. <br />
            <span className="text-blue-500">Start seeing it.</span>
          </h2>

          <p className="text-gray-400 text-lg md:text-xl mt-8 max-w-2xl leading-relaxed font-medium">
            Experience your codebase like never before. No configuration, no
            clunky extensions, and zero indexing wait times. Just drop a
            repository and explore.
          </p>

          <button className="mt-12 flex items-center gap-3 text-white bg-blue-700 hover:bg-blue-600 px-10 py-4 rounded-full transition-all duration-300 transform active:scale-95 cursor-pointer text-xl font-bold border-b-4 border-blue-900">
            <LucideLayers size={24} strokeWidth={2.5} />
            Get started
          </button>
        </div>
      </section>

      <footer className="relative z-10 w-full max-w-7xl mx-auto px-6 py-12 border-t border-gray-800">
        <div className="flex flex-col md:flex-row justify-between items-start gap-12">
          {/* Left Side */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-black text-xl">R</span>
              </div>
              <span className="text-gray-100 font-bold text-xl tracking-tight">
                RepoOrbit
              </span>
            </div>
            <p className="text-gray-500 text-sm max-w-xs leading-relaxed">
              The ultimate spatial visualization tool for modern codebases.
              Built for developers who want to see the bigger picture.
            </p>
          </div>

          {/* Right Side */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-12 md:gap-24">
            <div className="flex flex-col gap-4">
              <h4 className="text-gray-100 font-bold text-sm uppercase tracking-widest">
                Product
              </h4>
              <ul className="flex flex-col gap-2 text-gray-500 text-sm">
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Explorer
                </li>
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Root System
                </li>
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Galaxy View
                </li>
              </ul>
            </div>

            <div className="flex flex-col gap-4">
              <h4 className="text-gray-100 font-bold text-sm uppercase tracking-widest">
                Resources
              </h4>
              <ul className="flex flex-col gap-2 text-gray-500 text-sm">
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Documentation
                </li>
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Github
                </li>
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Support
                </li>
              </ul>
            </div>

            <div className="flex flex-col gap-4">
              <h4 className="text-gray-100 font-bold text-sm uppercase tracking-widest">
                Legal
              </h4>
              <ul className="flex flex-col gap-2 text-gray-500 text-sm">
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Privacy
                </li>
                <li className="hover:text-blue-500 cursor-pointer transition-colors">
                  Terms
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-20 pt-8 border-t border-gray-800/50 flex flex-col md:flex-row justify-between items-center gap-6">
          <p className="text-gray-600 text-xs font-mono uppercase tracking-tighter">
            © 2024 RepoOrbit Inc. All rights reserved.
          </p>

          <div className="flex items-center gap-6 text-gray-500">
            {/* i dont have these */}
            <span className="hover:text-white cursor-pointer transition-colors text-xs font-bold uppercase tracking-widest">
              Twitter
            </span>
            <span className="hover:text-white cursor-pointer transition-colors text-xs font-bold uppercase tracking-widest">
              Discord
            </span>
            <div className="h-4 w-px bg-gray-800" />
            <span className="text-gray-600 text-xs font-mono">
              Built with React & WebGL
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Page;
