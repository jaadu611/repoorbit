// just a navbar

"use client";

import { useState } from "react";
import { navlinks } from "@/constants/navbar.constants";
import Link from "next/link";
import { LucideIcon, LucideLayers } from "lucide-react";

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 bg-gray-900 border-b border-gray-700">
      <div className="relative flex items-center justify-between px-6 py-2.5 z-50 bg-gray-900">
        <div className="flex items-center gap-1.5">
          <div className="h-6 w-6 rounded-full bg-blue-500" />
          <span className="text-xl font-bold tracking-tighter text-gray-100">
            Repo<span className="text-blue-500">Orbit</span>
          </span>
        </div>

        <ul className="hidden md:flex items-center gap-3 font-medium">
          {navlinks.map(
            ({
              title,
              link,
              icon: Icon,
            }: {
              title: string;
              link: string;
              icon: LucideIcon;
            }) => (
              <Link key={title} href={link}>
                <li className="flex items-center gap-1.5 border border-gray-700 text-gray-300 px-2.5 py-0.5 rounded-full hover:border-blue-500 transition-colors duration-300 cursor-pointer text-xs">
                  {Icon && <Icon size={12} className="text-blue-500" />}
                  {title}
                </li>
              </Link>
            ),
          )}

          <li>
            <Link href={"/workspace"}>
              <button className="flex items-center gap-1.5 text-gray-100 border border-blue-700 px-3 py-1 rounded-full bg-blue-700 hover:bg-blue-600 hover:border-blue-600 transition-colors duration-300 cursor-pointer text-xs">
                <LucideLayers size={12} />
                Get started
              </button>
            </Link>
          </li>
        </ul>

        <button
          className="md:hidden p-1.5 text-gray-400 hover:text-white transition-colors focus:outline-none"
          onClick={() => setIsOpen(!isOpen)}
        >
          <div className="w-5 h-3.5 relative flex flex-col justify-between">
            <span
              className={`w-full h-0.5 bg-current transition-all duration-300 ${isOpen ? "rotate-45 translate-y-[6px]" : ""}`}
            />
            <span
              className={`w-full h-0.5 bg-current transition-all duration-300 ${isOpen ? "opacity-0" : ""}`}
            />
            <span
              className={`w-full h-0.5 bg-current transition-all duration-300 ${isOpen ? "-rotate-45 -translate-y-[6px]" : ""}`}
            />
          </div>
        </button>
      </div>

      <div
        className={`
            absolute right-6 top-full bg-gray-900 border border-gray-700 rounded-xl shadow-2xl
            transition-all duration-300 ease-in-out md:hidden overflow-hidden
            ${isOpen ? "max-h-[400px] opacity-100 translate-y-2" : "max-h-0 opacity-0 translate-y-0 pointer-events-none"}
          `}
      >
        <ul className="flex flex-col gap-2 p-4 font-medium items-end">
          {navlinks.map(
            ({
              title,
              link,
              icon: Icon,
            }: {
              title: string;
              link: string;
              icon: LucideIcon;
            }) => (
              <Link
                key={title}
                href={link}
                onClick={() => setIsOpen(false)}
                className="w-full"
              >
                <li className="flex items-center justify-center gap-2 border border-gray-700 text-gray-300 px-3 py-1.5 rounded-full hover:border-blue-500 transition-colors duration-300 cursor-pointer text-center text-xs">
                  {Icon && <Icon size={12} className="text-blue-500" />}
                  {title}
                </li>
              </Link>
            ),
          )}
          <li className="w-full pt-1">
            <button className="w-full flex items-center justify-center gap-2 text-gray-100 border border-blue-700 px-3 py-1.5 rounded-full bg-blue-700 hover:bg-blue-600 hover:border-blue-600 transition-colors duration-300 cursor-pointer text-xs">
              <LucideLayers size={12} />
              Get started
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
};

export default Navbar;
